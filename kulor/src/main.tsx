import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { player } from './engine/player';
import { useStore } from './store';
import * as actions from './ui/actions';
import { renderProject } from './engine/render';
import './ui/app.css';

createRoot(document.getElementById('root')!).render(<App />);

// Handle for the end-to-end test driver.
Object.assign(window, { __kulor: { store: useStore, player, actions, renderProject } });
