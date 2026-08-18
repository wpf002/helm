import { createRoot } from 'react-dom/client';
import App from './App';
import '@xterm/xterm/css/xterm.css';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

// No StrictMode: its double-invoked effects would spawn and orphan a second
// pty on every mount in dev.
createRoot(container).render(<App />);
