import { useState } from 'react';
import { MediaPool } from './MediaPool';
import { TitlesPanel } from './TitlesPanel';
import { Viewer } from './Viewer';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';

export function EditPage() {
  const [tab, setTab] = useState<'media' | 'titles'>('media');
  return (
    <div className="edit-page">
      <section className="panel edit-pool">
        <div className="pool-tabs">
          <button className={tab === 'media' ? 'toggle on' : 'toggle'} onClick={() => setTab('media')}>Media</button>
          <button className={tab === 'titles' ? 'toggle on' : 'toggle'} onClick={() => setTab('titles')}>Titlar</button>
        </div>
        {tab === 'media' ? <MediaPool /> : <TitlesPanel />}
      </section>
      <section className="panel edit-viewer">
        <Viewer />
      </section>
      <section className="panel edit-inspector">
        <Inspector />
      </section>
      <section className="panel edit-timeline">
        <Timeline />
      </section>
    </div>
  );
}
