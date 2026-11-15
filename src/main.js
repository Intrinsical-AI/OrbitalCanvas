import './styles.css';
import { version } from '../package.json';
import { App } from './ui/app.js';

const app = new App(document, version);
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
