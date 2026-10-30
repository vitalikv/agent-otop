import type { Conversation, Message } from '../types/chat';
import { Icons } from './icons';

export class ChatView {
  readonly element = document.createElement('section');
  private readonly examples = [
    { icon: 'tool', title: 'Монтаж системы', text: 'С чего начать и как всё подключить', question: 'С чего начать монтаж отопления в частном доме?' },
    { icon: 'pipes', title: 'Трубы и фитинги', text: 'Разобраться в деталях и соединениях', question: 'Как подобрать фитинги для труб отопления?' },
    { icon: 'gauge', title: 'Что-то не работает', text: 'Найти причину и понять, что делать', question: 'Радиатор плохо греет. Что нужно проверить?' },
    { icon: 'heat', title: 'Тёплый пол', text: 'От укладки труб до настройки', question: 'Что нужно учесть при монтаже водяного тёплого пола?' },
  ];

  constructor(private readonly onExample: (question: string) => void) {
    this.element.className = 'chat-scroll';
  }

  render(chat: Conversation | undefined): void {
    this.element.replaceChildren();
    if (!chat?.messages.length) {
      this.element.innerHTML = `<div class="welcome"><div class="eyebrow"><span></span> ВАШ ПОМОЩНИК ПО ОТОПЛЕНИЮ</div><div class="welcome-mark">${Icons.get('heat')}</div><h1>Пусть дома будет тепло.</h1><p class="welcome-description">Разберёмся с монтажом, подберём комплектующие<br class="desktop-break"> и найдём ответы на вопросы о вашей системе.</p><div class="examples"></div><div class="welcome-note">${Icons.get('book')} От первого соединения до комфортной температуры</div></div>`;
      const grid = this.element.querySelector('.examples')!;
      this.examples.forEach(example => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'example-card';
        button.innerHTML = `<span class="example-icon">${Icons.get(example.icon)}</span><span class="example-copy"><strong>${example.title}</strong><span>${example.text}</span></span><span class="example-chevron">${Icons.get('chevron')}</span>`;
        button.addEventListener('click', () => this.onExample(example.question));
        grid.append(button);
      });
      return;
    }
    const thread = document.createElement('div');
    thread.className = 'thread';
    thread.setAttribute('aria-label', 'Переписка');
    chat.messages.forEach(message => thread.append(this.messageElement(message)));
    this.element.append(thread);
    this.scrollBottom();
  }

  updateMessage(message: Message): void {
    const nearBottom = this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight < 100;
    const target = Array.from(this.element.querySelectorAll<HTMLElement>('[data-message-id]')).find(el => el.dataset.messageId === message.id);
    if (target) {
      const body = target.querySelector<HTMLElement>('.message-body')!;
      body.textContent = message.content || 'Формирует ответ…';
      body.classList.toggle('thinking', !message.content);
    }
    if (nearBottom) this.scrollBottom();
  }

  private messageElement(message: Message): HTMLElement {
    const element = document.createElement('article');
    element.className = `message message-${message.role}`;
    element.dataset.messageId = message.id;
    element.innerHTML = `<div class="message-avatar">${message.role === 'assistant' ? Icons.get('heat') : 'ВЫ'}</div><div class="message-content"><div class="message-label">${message.role === 'assistant' ? 'Тепло' : 'Вы'}<span>${message.role === 'assistant' ? 'Демо-помощник' : ''}</span></div><div class="message-body"></div></div>`;
    const body = element.querySelector('.message-body')!;
    body.textContent = message.content || 'Формирует ответ…';
    body.classList.toggle('thinking', !message.content);
    return element;
  }

  private scrollBottom(): void { this.element.scrollTop = this.element.scrollHeight; }
}
