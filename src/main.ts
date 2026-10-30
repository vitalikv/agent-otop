import './styles/main.css';
import { ChatApp } from './app/ChatApp';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing');
new ChatApp(root);
