import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { App } from './App';
import { connect, restoreCache } from './link';
import { restoreOutbox } from './rec';

restoreCache();
void restoreOutbox();
connect();
if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
createRoot(document.getElementById('root')!).render(<App />);
