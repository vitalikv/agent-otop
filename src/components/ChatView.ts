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

  constructor(private readonly onExample: (question: string) => void, private readonly demo = false) {
    this.element.className = 'chat-scroll';
    if (!demo) this.examples.splice(0, this.examples.length,
      { icon: 'gauge', title: 'Расход теплоносителя', text: 'Расчёт по нагрузке и температурам', question: 'Рассчитать расход теплоносителя' },
      { icon: 'heat', title: 'Есть исходные данные', text: '8 кВт, вода, подача и обратка 60/40 °C', question: 'Ориентировочный расход воды: нагрузка участка 8 кВт, температуры 60/40 °C' },
    );
  }

  render(chat: Conversation | undefined): void {
    this.element.replaceChildren();
    if (!chat?.messages.length) {
      this.element.innerHTML = `<div class="welcome"><div class="eyebrow"><span></span> ВАШ ПОМОЩНИК ПО ОТОПЛЕНИЮ</div><div class="welcome-mark">${Icons.get('heat')}</div><h1>Пусть дома будет тепло.</h1><p class="welcome-description">Разберёмся с монтажом, подберём комплектующие<br class="desktop-break"> и найдём ответы на вопросы о вашей системе.</p><div class="examples"></div><div class="welcome-note">${Icons.get('book')} От первого соединения до комфортной температуры</div></div>`;
      if (!this.demo) {
        this.element.querySelector('.welcome-description')!.textContent = 'Рассчитаем проектный расход воды по нагрузке и температурам. Если данных не хватает, помощник задаст уточнение.';
        this.element.querySelector('.welcome-note')!.textContent = 'Первый сценарий: расчёт расхода воды с источниками';
      }
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
    chat.messages.forEach((message, index) => thread.append(this.messageElement(message, index === chat.messages.length - 1)));
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
      this.renderDetails(target, message, target === this.element.querySelector('.thread')?.lastElementChild);
    }
    if (nearBottom) this.scrollBottom();
  }

  private messageElement(message: Message, latest: boolean): HTMLElement {
    const element = document.createElement('article');
    element.className = `message message-${message.role}`;
    element.dataset.messageId = message.id;
    element.innerHTML = `<div class="message-avatar">${message.role === 'assistant' ? Icons.get('heat') : 'ВЫ'}</div><div class="message-content"><div class="message-label">${message.role === 'assistant' ? 'Тепло' : 'Вы'}<span>${message.role === 'assistant' ? 'Демо-помощник' : ''}</span></div><div class="message-body"></div></div>`;
    const body = element.querySelector('.message-body')!;
    body.textContent = message.content || 'Формирует ответ…';
    body.classList.toggle('thinking', !message.content);
    if (message.role === 'assistant') element.querySelector('.message-label span')!.textContent = message.mode === 'local' ? 'Локальный сервис' : 'Демо-помощник';
    this.renderDetails(element, message, latest);
    return element;
  }

  private renderDetails(element: HTMLElement, message: Message, latest: boolean): void {
    element.querySelector('.message-details')?.remove();
    if (message.role !== 'assistant') return;
    if (!message.sources?.length && !(latest && message.choices?.length)) return;
    const details = document.createElement('div');
    details.className = 'message-details';
    for (const source of message.sources ?? []) {
      if (!/^\/api\/sources\/[a-zA-Z0-9.%-]+$/.test(source.href)) continue;
      const link = document.createElement('a');
      link.textContent = `Источник: ${source.title}`;
      link.href = source.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      details.append(link);
    }
    if (latest && message.clarification) details.setAttribute('aria-label', 'Уточняющий вопрос');
    if (latest) for (const choice of message.choices ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice;
      button.addEventListener('click', () => this.onExample(choice));
      details.append(button);
    }
    element.querySelector('.message-content')!.append(details);
  }

  private scrollBottom(): void { this.element.scrollTop = this.element.scrollHeight; }
}
