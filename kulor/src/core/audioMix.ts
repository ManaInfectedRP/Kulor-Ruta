// Turns the audio side of a project into one ffmpeg command that renders a stereo WAV.
// Runs in the main process during export; kept pure so it can be tested without Electron.

import type { Clip, Project, Track } from './types';
import { SAMPLE_RATE } from './types';
import { audibleTracks, dbToGain, mediaOf } from './timeline';

export interface AudioMixPlan {
  /** Null when nothing is audible in the range. */
  args: string[] | null;
}

const fixed = (n: number) => n.toFixed(6);

/** Equal power stereo balance. Unity at centre, so an untouched track is not attenuated. */
export function panGains(pan: number): { left: number; right: number } {
  const angle = ((pan + 1) * Math.PI) / 4;
  return { left: Math.cos(angle) * Math.SQRT2, right: Math.sin(angle) * Math.SQRT2 };
}

interface Placed {
  clip: Clip;
  /** Seconds into the source where this range starts. */
  seekSec: number;
  durationSec: number;
  delayMs: number;
  /** Fades stated relative to the part of the clip that falls inside the range. */
  fadeInSec: number;
  fadeOutSec: number;
  fadeOutStartSec: number;
  fadeInStartSec: number;
}

function place(clip: Clip, fps: number, from: number, to: number): Placed | null {
  const start = Math.max(clip.start, from);
  const end = Math.min(clip.start + clip.duration, to);
  if (end <= start) return null;

  const skipped = start - clip.start;
  const durationSec = (end - start) / fps;
  const fadeOutSec = clip.fadeOut / fps;
  const clipEndSec = (clip.start + clip.duration - start) / fps;
  return {
    clip,
    seekSec: (clip.sourceIn + skipped) / fps,
    durationSec,
    delayMs: Math.round(((start - from) / fps) * 1000),
    fadeInSec: clip.fadeIn / fps,
    fadeInStartSec: -skipped / fps,
    fadeOutSec,
    fadeOutStartSec: clipEndSec - fadeOutSec,
  };
}

/**
 * Builds the mix for frames [from, to). outputPath receives 32 bit float PCM, exactly as long as
 * the range so that it can be muxed next to the rendered video.
 */
export function buildAudioMix(p: Project, from: number, to: number, outputPath: string): AudioMixPlan {
  const inputs: string[] = [];
  const graph: string[] = [];
  const trackOutputs: string[] = [];
  let index = 0;

  const addTrack = (t: Track) => {
    const labels: string[] = [];
    for (const clip of p.clips) {
      if (clip.trackId !== t.id) continue;
      const media = mediaOf(p, clip);
      if (!media || media.offline || (media.kind !== 'audio' && !media.hasAudio)) continue;
      const placed = place(clip, p.fps, from, to);
      if (!placed) continue;

      inputs.push('-ss', fixed(placed.seekSec), '-t', fixed(placed.durationSec), '-i', media.path);
      const chain = [
        `aresample=${SAMPLE_RATE}`,
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        `volume=${fixed(dbToGain(clip.gainDb))}`,
      ];
      if (placed.fadeInSec > 0 && placed.fadeInStartSec + placed.fadeInSec > 0)
        chain.push(`afade=t=in:st=${fixed(placed.fadeInStartSec)}:d=${fixed(placed.fadeInSec)}`);
      if (placed.fadeOutSec > 0)
        chain.push(`afade=t=out:st=${fixed(placed.fadeOutStartSec)}:d=${fixed(placed.fadeOutSec)}`);
      if (placed.delayMs > 0) chain.push(`adelay=${placed.delayMs}:all=1`);

      const label = `c${index}`;
      graph.push(`[${index}:a]${chain.join(',')}[${label}]`);
      labels.push(`[${label}]`);
      index++;
    }
    if (labels.length === 0) return;

    const { left, right } = panGains(t.pan);
    const label = `t${trackOutputs.length}`;
    graph.push(
      `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,` +
        `volume=${fixed(dbToGain(t.gainDb))},pan=stereo|c0=${fixed(left)}*c0|c1=${fixed(right)}*c1[${label}]`,
    );
    trackOutputs.push(`[${label}]`);
  };

  audibleTracks(p).forEach(addTrack);
  if (trackOutputs.length === 0) return { args: null };

  const totalSec = (to - from) / p.fps;
  graph.push(
    `${trackOutputs.join('')}amix=inputs=${trackOutputs.length}:normalize=0:duration=longest,` +
      `apad=whole_dur=${fixed(totalSec)},atrim=0:${fixed(totalSec)},asetpts=N/SR/TB[out]`,
  );

  return {
    args: [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...inputs,
      '-filter_complex', graph.join(';'),
      '-map', '[out]',
      '-c:a', 'pcm_f32le', '-ar', String(SAMPLE_RATE),
      outputPath,
    ],
  };
}
