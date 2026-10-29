import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installPortInbox } from './store/port-client.js';
import './styles/base.css';

// Installed BEFORE React mounts: the main process transfers a session's port while handling
// `sessions:open`, which can be before that call's reply (carrying the token) reaches us.
installPortInbox();

const container = document.getElementById('root');
if (!container) throw new Error('The renderer page has no #root element.');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
