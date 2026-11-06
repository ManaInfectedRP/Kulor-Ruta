import { describe, expect, it } from 'vitest';
import {
  addClipFromMedia, addTitleClip, addTrack, deleteClips, evalProperty, fadeGain, layersAt, moveClips, nearestSnap, newProject,
  removeKeyframe, removeTrack, setKeyframe, splitClips, timelineEnd, trimClip, updateClip,
} from '../src/core/timeline';
import { channelsToWheel, defaultNode, isIdentityNode, nodeUniforms, sampleCurve, wheelToChannels } from '../src/core/grade';
import { buildAudioMix, panGains } from '../src/core/audioMix';
import { applyTitleAnimation, defaultTitle, layoutTitle, titleName, TITLE_PRESETS } from '../src/core/title';
import type { MediaItem, Project } from '../src/core/types';

const media = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: 'm1', path: 'C:/a.mp4', name: 'a.mp4', kind: 'video', durationSec: 10, width: 1920, height: 1080, fps: 30,
  hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4', sizeBytes: 1, colorMatrix: 'bt709',
  needsProxy: false, proxyState: 'none', ...over,
});

function withClip(over: Partial<MediaItem> = {}): Project {
  const m = media(over);
  const p = newProject();
  return addClipFromMedia({ ...p, media: [m] }, m, undefined, 0);
}

describe('placing clips', () => {
  it('turns video with sound into a linked pair on the right kinds of track', () => {
    const p = withClip();
    expect(p.clips).toHaveLength(2);
    expect(p.clips[0].linkId).toBeDefined();
    expect(p.clips[0].linkId).toBe(p.clips[1].linkId);
    expect(p.tracks.find((t) => t.id === p.clips[0].trackId)?.kind).toBe('video');
    expect(p.tracks.find((t) => t.id === p.clips[1].trackId)?.kind).toBe('audio');
    expect(p.clips[0].duration).toBe(300);
  });

  it('falls through to a free track instead of overlapping', () => {
    const m = media();
    const p = addClipFromMedia(withClip(), m, undefined, 100);
    const video = p.clips.filter((c) => p.tracks.find((t) => t.id === c.trackId)?.kind === 'video');
    expect(new Set(video.map((c) => c.trackId)).size).toBe(2);
  });

  it('gives still images a default length and no audio', () => {
    const p = withClip({ kind: 'image', hasAudio: false, durationSec: 0 });
    expect(p.clips).toHaveLength(1);
    expect(p.clips[0].duration).toBe(150);
  });
});

describe('editing', () => {
  it('moves linked clips together and refuses collisions', () => {
    let p = addClipFromMedia(withClip(), media(), undefined, 300);
    const [first] = p.clips;
    const blocked = moveClips(p, [first.id], 10);
    expect(blocked).toBe(p); // would run into the second clip

    p = moveClips(p, [p.clips[2].id], 50);
    expect(p.clips[2].start).toBe(350);
    expect(p.clips[3].start).toBe(350);
  });

  it('refuses a move to before frame zero', () => {
    const p = withClip();
    expect(moveClips(p, [p.clips[0].id], -1)).toBe(p);
  });

  it('moves between tracks of the same kind and keeps the linked audio where it is', () => {
    const p = withClip();
    const moved = moveClips(p, [p.clips[0].id], 0, 1);
    expect(moved.clips[0].trackId).toBe(p.tracks[1].id);
    expect(moved.clips[1].trackId).toBe(p.clips[1].trackId);
  });

  it('splits both halves of a pair and keeps source positions continuous', () => {
    const p = withClip();
    const s = splitClips(p, [p.clips[0].id], 100);
    expect(s.clips).toHaveLength(4);
    const video = s.clips.filter((c) => c.trackId === p.tracks[0].id).sort((a, b) => a.start - b.start);
    expect(video[0].duration).toBe(100);
    expect(video[1].start).toBe(100);
    expect(video[1].sourceIn).toBe(100);
    expect(video[1].duration).toBe(200);

    // Right halves link to each other, not back to the left halves.
    const rights = s.clips.filter((c) => c.start === 100);
    expect(rights[0].linkId).toBe(rights[1].linkId);
    expect(rights[0].linkId).not.toBe(video[0].linkId);
  });

  it('does not let split halves share a grade object', () => {
    const p = withClip();
    const s = splitClips(p, [p.clips[0].id], 100);
    const halves = s.clips.filter((c) => c.trackId === p.tracks[0].id);
    expect(halves[0].grade).not.toBe(halves[1].grade);
  });

  it('moves keyframes to whichever half they belong to', () => {
    let p = withClip();
    p = updateClip(p, p.clips[0].id, (c) => setKeyframe(setKeyframe(c, 'x', 10, 0.1), 'x', 150, 0.5));
    const s = splitClips(p, [p.clips[0].id], 100);
    const halves = s.clips.filter((c) => c.trackId === p.tracks[0].id).sort((a, b) => a.start - b.start);
    expect(halves[0].keyframes.x).toEqual([{ frame: 10, value: 0.1 }]);
    expect(halves[1].keyframes.x).toEqual([{ frame: 50, value: 0.5 }]);
  });

  it('clamps trims to the source and keeps the pair in sync', () => {
    const p = withClip();
    const id = p.clips[0].id;
    const extended = trimClip(p, id, 'end', 500);
    expect(extended.clips[0].duration).toBe(300); // the file has no more frames

    const trimmed = trimClip(p, id, 'start', 30);
    expect(trimmed.clips[0].start).toBe(30);
    expect(trimmed.clips[0].sourceIn).toBe(30);
    expect(trimmed.clips[1].start).toBe(30);
    expect(trimmed.clips[1].duration).toBe(270);

    const back = trimClip(trimmed, id, 'start', -100);
    expect(back.clips[0].start).toBe(0);
    expect(back.clips[0].sourceIn).toBe(0);
  });

  it('stops a trim at the neighbouring clip', () => {
    let p = addClipFromMedia(withClip(), media(), undefined, 300);
    p = trimClip(p, p.clips[2].id, 'start', 40);
    p = trimClip(p, p.clips[2].id, 'start', -100);
    expect(p.clips[2].start).toBe(300);
  });

  it('shifts keyframes so a start trim leaves the animation in place', () => {
    let p = withClip();
    p = updateClip(p, p.clips[0].id, (c) => setKeyframe(c, 'x', 60, 0.5));
    const t = trimClip(p, p.clips[0].id, 'start', 20);
    expect(t.clips[0].keyframes.x).toEqual([{ frame: 40, value: 0.5 }]);
  });

  it('ripple delete closes the gap', () => {
    let p = addClipFromMedia(withClip(), media(), undefined, 300);
    p = addClipFromMedia(p, media(), undefined, 600);
    const r = deleteClips(p, [p.clips[2].id], true);
    expect(r.clips).toHaveLength(4);
    expect(timelineEnd(r)).toBe(600);
    expect(timelineEnd(deleteClips(p, [p.clips[2].id], false))).toBe(900);
  });

  it('only removes empty tracks and always keeps one of each kind', () => {
    const p = withClip();
    const occupied = p.clips[0].trackId;
    expect(removeTrack(p, occupied)).toBe(p);
    const free = p.tracks[1].id;
    const removed = removeTrack(p, free);
    expect(removed.tracks).toHaveLength(3);
    const onlyOne = removed.tracks.find((t) => t.kind === 'video')!.id;
    expect(removeTrack(removed, onlyOne)).toBe(removed);
    expect(addTrack(p, 'video').tracks.map((t) => t.kind)).toEqual(['video', 'video', 'video', 'audio', 'audio']);
  });
});

describe('keyframes', () => {
  it('interpolates and holds at the ends', () => {
    let p = withClip();
    p = updateClip(p, p.clips[0].id, (c) => setKeyframe(setKeyframe(c, 'scale', 10, 1), 'scale', 20, 2));
    const c = p.clips[0];
    expect(evalProperty(c, 'scale', 0)).toBe(1);
    expect(evalProperty(c, 'scale', 15)).toBeCloseTo(1.5);
    expect(evalProperty(c, 'scale', 30)).toBe(2);
  });

  it('keeps the value when the last keyframe is removed', () => {
    let p = withClip();
    p = updateClip(p, p.clips[0].id, (c) => setKeyframe(c, 'opacity', 5, 0.4));
    const c = removeKeyframe(p.clips[0], 'opacity', 5);
    expect(c.keyframes.opacity).toBeUndefined();
    expect(c.transform.opacity).toBeCloseTo(0.4);
  });
});

describe('what is on screen', () => {
  it('stacks tracks bottom first and skips hidden ones', () => {
    let p = withClip();
    p = addClipFromMedia(p, media(), p.tracks[1].id, 0);
    expect(layersAt(p, 10).map((l) => l.clip.trackId)).toEqual([p.tracks[0].id, p.tracks[1].id]);
    p = { ...p, tracks: p.tracks.map((t, i) => (i === 1 ? { ...t, hidden: true } : t)) };
    expect(layersAt(p, 10)).toHaveLength(1);
  });

  it('shows nothing in a gap', () => {
    expect(layersAt(withClip(), 500)).toEqual([]);
  });

  it('runs the outgoing clip past its end during a dissolve', () => {
    let p = addClipFromMedia(withClip(), media(), undefined, 300);
    p = updateClip(p, p.clips[2].id, (c) => ({ ...c, dissolveIn: 9 }));
    const layers = layersAt(p, 304);
    expect(layers).toHaveLength(2);
    expect(layers[0].clip.id).toBe(p.clips[0].id);
    expect(layers[1].opacity).toBeCloseTo(0.5);
    // Past the source end the frame is held, never read out of range.
    expect(layers[0].sourceFrame).toBe(299);
  });

  it('fades without ever dropping a clip to fully black on its first frame', () => {
    let p = withClip();
    p = updateClip(p, p.clips[0].id, (c) => ({ ...c, fadeIn: 9, fadeOut: 9 }));
    expect(layersAt(p, 0)[0].opacity).toBeCloseTo(0.1);
    expect(layersAt(p, 299)[0].opacity).toBeCloseTo(0.1);
    expect(layersAt(p, 150)[0].opacity).toBe(1);
  });

  it('computes audio fades', () => {
    let p = withClip();
    p = updateClip(p, p.clips[1].id, (c) => ({ ...c, fadeIn: 10 }));
    expect(fadeGain(p.clips[1], 0)).toBe(0);
    expect(fadeGain(p.clips[1], 5)).toBe(0.5);
    expect(fadeGain(p.clips[1], 100)).toBe(1);
  });
});

describe('snapping', () => {
  it('picks the nearest point inside the tolerance', () => {
    expect(nearestSnap([0, 100, 200], 104, 5)).toBe(100);
    expect(nearestSnap([0, 100, 200], 110, 5)).toBeNull();
  });
});

describe('grading maths', () => {
  it('leaves an untouched node as identity', () => {
    const n = defaultNode('x');
    expect(isIdentityNode(n)).toBe(true);
    const u = nodeUniforms(n);
    expect(u.gain).toEqual([1, 1, 1]);
    expect(u.lift).toEqual([0, 0, 0]);
    expect(u.gamma).toEqual([1, 1, 1]);
  });

  it('samples an identity curve as a straight line', () => {
    const lut = sampleCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }], 256);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBeCloseTo(i / 255, 5);
  });

  it('passes through its points and never overshoots', () => {
    const points = [{ x: 0, y: 0 }, { x: 0.5, y: 0.9 }, { x: 0.55, y: 0.9 }, { x: 1, y: 1 }];
    const lut = sampleCurve(points, 256);
    expect(lut[Math.round(0.5 * 255)]).toBeCloseTo(0.9, 1);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-5);
    expect(Math.max(...lut)).toBeLessThanOrEqual(1 + 1e-5);
  });

  it('treats unsorted points correctly', () => {
    const lut = sampleCurve([{ x: 1, y: 1 }, { x: 0, y: 0 }], 11);
    expect(lut[5]).toBeCloseTo(0.5);
  });

  it('keeps gamma positive however far it is dragged', () => {
    const n = defaultNode('x');
    n.gamma = { r: -3, g: 0, b: 0, m: 0 };
    expect(nodeUniforms(n).gamma[0]).toBeGreaterThan(0);
  });

  it('maps a wheel position to balanced channels and back', () => {
    const c = wheelToChannels(0.3, 0.2);
    expect(c.r + c.g + c.b).toBeCloseTo(0);
    const back = channelsToWheel(c.r, c.g, c.b);
    expect(back.x).toBeCloseTo(0.3, 1);
    expect(back.y).toBeCloseTo(0.2, 1);
  });
});

describe('audio mix', () => {
  it('stays at unity for a centred track', () => {
    const { left, right } = panGains(0);
    expect(left).toBeCloseTo(1);
    expect(right).toBeCloseTo(1);
    expect(panGains(-1).right).toBeCloseTo(0);
  });

  it('returns nothing for a silent timeline', () => {
    const p = withClip({ hasAudio: false });
    expect(buildAudioMix(p, 0, 300, 'out.wav').args).toBeNull();
  });

  it('honours mute and solo', () => {
    let p = withClip();
    const audio = p.tracks.find((t) => t.kind === 'audio')!;
    const other = p.tracks.filter((t) => t.kind === 'audio')[1];
    p = { ...p, tracks: p.tracks.map((t) => (t.id === other.id ? { ...t, solo: true } : t)) };
    expect(buildAudioMix(p, 0, 300, 'o.wav').args).toBeNull();
    p = { ...p, tracks: p.tracks.map((t) => (t.id === other.id ? { ...t, solo: false } : t.id === audio.id ? { ...t, muted: true } : t)) };
    expect(buildAudioMix(p, 0, 300, 'o.wav').args).toBeNull();
  });

  it('seeks into a clip when the range starts inside it', () => {
    const p = withClip();
    const args = buildAudioMix(p, 60, 120, 'o.wav').args!;
    expect(args[args.indexOf('-ss') + 1]).toBe('2.000000');
    expect(args[args.indexOf('-t') + 1]).toBe('2.000000');
  });

  it('delays a later clip by its timeline position', () => {
    let p = withClip();
    p = moveClips(p, [p.clips[1].id], 30);
    const args = buildAudioMix(p, 0, 330, 'o.wav').args!;
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('adelay=1000:all=1');
  });
});

describe('titles', () => {
  const metrics = { measure: (line: string) => line.length * 10, ascent: 8, descent: 2 };

  it('takes the highest free video track', () => {
    const p = addTitleClip(withClip(), defaultTitle(), undefined, 0);
    const clip = p.clips.at(-1)!;
    expect(clip.title).toBeDefined();
    expect(clip.trackId).toBe(p.tracks[1].id);
    expect(clip.duration).toBe(150);
  });

  it('honours a free preferred track and skips an occupied one', () => {
    const base = withClip();
    const v1 = base.tracks[0].id;
    expect(addTitleClip(base, defaultTitle(), v1, 400).clips.at(-1)!.trackId).toBe(v1);
    expect(addTitleClip(base, defaultTitle(), v1, 0).clips.at(-1)!.trackId).toBe(base.tracks[1].id);
  });

  it('adds a track when every video track is occupied', () => {
    let p = withClip();
    p = addTitleClip(p, defaultTitle(), undefined, 0);
    const before = p.tracks.filter((t) => t.kind === 'video').length;
    p = addTitleClip(p, defaultTitle(), undefined, 0);
    const video = p.tracks.filter((t) => t.kind === 'video');
    expect(video).toHaveLength(before + 1);
    expect(p.clips.at(-1)!.trackId).toBe(video.at(-1)!.id);
  });

  it('is drawn above the video and has no media', () => {
    const p = addTitleClip(withClip(), defaultTitle(), undefined, 0);
    const layers = layersAt(p, 10);
    expect(layers).toHaveLength(2);
    expect(layers[1].clip.title).toBeDefined();
    expect(layers[1].media).toBeNull();
    expect(layers[1].sourceFrame).toBe(0);
  });

  it('can be trimmed longer in both directions', () => {
    let p = addTitleClip({ ...newProject(), media: [] }, defaultTitle(), undefined, 100);
    const id = p.clips[0].id;
    p = trimClip(p, id, 'end', 500);
    expect(p.clips[0].duration).toBe(650);
    p = trimClip(p, id, 'start', -60);
    expect(p.clips[0].start).toBe(40);
    expect(p.clips[0].duration).toBe(710);
    expect(p.clips[0].sourceIn).toBe(0);
  });

  it('lets a still image grow to the left too', () => {
    let p = withClip({ kind: 'image', hasAudio: false, durationSec: 0 });
    p = moveClips(p, [p.clips[0].id], 100);
    p = trimClip(p, p.clips[0].id, 'start', -50);
    expect(p.clips[0].start).toBe(50);
    expect(p.clips[0].duration).toBe(200);
  });

  it('keeps its text on both sides of a split', () => {
    const p = addTitleClip(newProject(), { ...defaultTitle(), text: 'Hej' }, undefined, 0);
    const s = splitClips(p, [p.clips[0].id], 60);
    expect(s.clips.map((c) => c.title?.text)).toEqual(['Hej', 'Hej']);
    expect(s.clips[1].start).toBe(60);
  });

  it('can be the outgoing clip of a dissolve', () => {
    let p = addTitleClip(newProject(), defaultTitle(), undefined, 0);
    p = addTitleClip(p, defaultTitle(), p.clips[0].trackId, 150);
    p = updateClip(p, p.clips[1].id, (c) => ({ ...c, dissolveIn: 9 }));
    expect(layersAt(p, 152)).toHaveLength(2);
  });

  it('names a clip after the first line with text', () => {
    expect(titleName({ ...defaultTitle(), text: '\n  Hej  \nrad två' })).toBe('Hej');
    expect(titleName({ ...defaultTitle(), text: '  ' })).toBe('Tom titel');
  });

  it('centres the block on its position', () => {
    const t = { ...defaultTitle(), text: 'abcd', posX: 0.5, posY: 0.5 };
    const { lines, box } = layoutTitle(t, 1000, 500, metrics);
    expect(box.x + box.width / 2).toBeCloseTo(500);
    expect(box.y + box.height / 2).toBeCloseTo(250);
    expect(lines[0].x).toBe(480);
    expect(lines[0].y).toBe(box.y + 8);
  });

  it('aligns lines inside the block', () => {
    const at = (align: 'left' | 'center' | 'right') =>
      layoutTitle({ ...defaultTitle(), text: 'abcdef\nab', align, posX: 0.5 }, 1000, 500, metrics).lines[1].x;
    expect(at('left')).toBe(470);
    expect(at('center')).toBe(490);
    expect(at('right')).toBe(510);
  });

  it('keeps the spacing of an empty line but does not draw it', () => {
    const t = { ...defaultTitle(), text: 'a\n\nb', size: 0.1, lineHeight: 1 };
    const { lines } = layoutTitle(t, 1000, 500, metrics);
    expect(lines).toHaveLength(2);
    expect(lines[1].y - lines[0].y).toBeCloseTo(100);
  });

  it('builds entrance animations and clears them again', () => {
    const p = addTitleClip(newProject(), defaultTitle(), undefined, 0);
    const c = p.clips[0];
    const rise = applyTitleAnimation(c, 'rise', 30);
    expect(rise.fadeIn).toBe(15);
    expect(evalProperty(rise, 'y', 0)).toBeCloseTo(0.06);
    expect(evalProperty(rise, 'y', 21)).toBeCloseTo(0);
    const none = applyTitleAnimation(rise, 'none', 30);
    expect(none.fadeIn).toBe(0);
    expect(none.keyframes).toEqual({});
  });

  it('never lets an animation outlast a very short clip', () => {
    const p = addTitleClip(newProject(), defaultTitle(), undefined, 0);
    const short = applyTitleAnimation({ ...p.clips[0], duration: 6 }, 'zoom', 30);
    expect(short.fadeIn + short.fadeOut).toBeLessThanOrEqual(6);
    expect(short.keyframes.scale?.at(-1)?.frame).toBeLessThanOrEqual(3);
  });

  it('ships presets with unique ids', () => {
    expect(new Set(TITLE_PRESETS.map((p) => p.id)).size).toBe(TITLE_PRESETS.length);
  });
});
