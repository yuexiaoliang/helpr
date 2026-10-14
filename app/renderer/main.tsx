import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WorkspaceStore } from './store';
import type { WorkspaceBridge } from '../shared/contracts';
import './base.css';

declare global {
  interface Window {
    workspace: WorkspaceBridge;
  }
}
const query = new URLSearchParams(location.search);
const surface = query.get('surface');
if (surface === 'chat' || surface === 'toast')
  document.body.style.background = 'transparent';
const store = new WorkspaceStore(window.workspace);
window.addEventListener('beforeunload', () => store.dispose());
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <App
      store={store}
      surface={
        surface === 'chat' || surface === 'panel' || surface === 'toast'
          ? surface
          : 'chrome'
      }
      taskId={query.get('taskId') ?? undefined}
    />,
  );
