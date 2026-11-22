import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { App } from './App';
import { Mini } from './Mini';

// The same page serves the floating live-transcript window.
createRoot(document.getElementById('root')!).render(location.hash === '#mini' ? <Mini /> : <App />);
