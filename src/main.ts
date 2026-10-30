import './styles/main.css';
import { ChatApp } from './app/ChatApp';
import { ApiChatProvider } from './services/ApiChatProvider';
import { ChatService } from './services/ChatService';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing');
const provider = import.meta.env.VITE_CHAT_MODE === 'demo' ? new ChatService() : new ApiChatProvider(import.meta.env.VITE_BOT_API_URL || '/api');
new ChatApp(root, provider);
