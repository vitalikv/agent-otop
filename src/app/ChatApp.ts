import { ChatView } from '../components/ChatView';
import { MessageInput } from '../components/MessageInput';
import { Icons } from '../components/icons';
import { ApiChatProvider } from '../services/ApiChatProvider';
import { StorageService } from '../services/StorageService';
import type { ChatProvider, Conversation, Message } from '../types/chat';

export class ChatApp {
  private readonly storage = new StorageService();
  private readonly chats: Conversation[] = this.storage.load();
  private activeId: string | undefined;
  private controller?: AbortController;
  private readonly view: ChatView;
  private readonly input: MessageInput;
  private readonly history: HTMLElement;
  private readonly title: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly liveStatus = document.createElement('div');

  constructor(private readonly root: HTMLElement, private readonly service: ChatProvider = new ApiChatProvider()) {
    this.root.innerHTML = `<div class="app-shell"><button class="sidebar-backdrop" aria-label="Закрыть меню"></button><aside class="sidebar"><a class="brand" href="./" aria-label="Тепло — главная"><span class="brand-icon">${Icons.get('heat')}</span><span>тепло<span class="brand-dot">.</span></span></a><div class="brand-caption">Есть вопрос — есть тепло</div><button class="new-chat">${Icons.get('plus')} Новый чат <span>↗</span></button><div class="history-label">ВАШИ ДИАЛОГИ</div><nav class="history" aria-label="История чатов"></nav><div class="sidebar-bottom"><div class="local-card"><span class="local-icon">${Icons.get('shield')}</span><div><strong>Остаётся на устройстве</strong><p>История хранится в браузере</p></div></div><div class="sidebar-footer"><span class="avatar">Т</span><div><strong>Локальное пространство</strong><span>Ваш личный помощник</span></div><span class="online-dot"></span></div></div></aside><main class="main"><header class="topbar"><div class="topbar-left"><button class="menu-button icon-button" aria-label="Открыть меню">${Icons.get('menu')}</button><span class="page-title">Новый диалог</span></div><span class="demo-badge"><span></span> Демо-режим</span></header><div class="conversation-area"></div><footer class="chat-footer"><div class="demo-notice">Локальная модель пока не подключена · Ответы демонстрационные</div><div class="input-mount"></div><p class="footer-note">Помощник может ошибаться. Важные решения сверяйте с документацией оборудования.</p><div class="storage-notice" role="status"></div></footer></main></div>`;
    this.history = this.root.querySelector('.history')!;
    this.title = this.root.querySelector('.page-title')!;
    this.notice = this.root.querySelector('.storage-notice')!;
    this.setConnection(this.service.mode === 'demo' ? 'Демо-режим' : 'Проверка сервиса…');
    this.root.querySelector('.demo-notice')!.textContent = this.service.mode === 'demo'
      ? 'Демо-режим · Ответы демонстрационные'
      : 'Расход воды · Локальный сервис на правилах · Без нейросети';
    if (this.service.checkConnection) void this.service.checkConnection().then(online => this.setConnection(online ? 'Сервис подключён' : 'Сервис недоступен'));
    this.liveStatus.className = 'sr-only';
    this.liveStatus.setAttribute('role', 'status');
    this.root.append(this.liveStatus);
    this.view = new ChatView(question => { void this.send(question); }, this.service.mode === 'demo');
    this.input = new MessageInput(text => { void this.send(text); }, () => this.controller?.abort());
    this.root.querySelector('.conversation-area')!.append(this.view.element);
    this.root.querySelector('.input-mount')!.append(this.input.element);
    this.root.querySelector('.new-chat')!.addEventListener('click', () => this.select(undefined));
    this.root.querySelector('.brand')!.addEventListener('click', event => { event.preventDefault(); this.select(undefined); });
    this.root.querySelector('.menu-button')!.addEventListener('click', () => this.toggleSidebar(true));
    this.root.querySelector('.sidebar-backdrop')!.addEventListener('click', () => this.toggleSidebar(false));
    this.root.addEventListener('keydown', event => { if (event.key === 'Escape') this.toggleSidebar(false); });
    window.addEventListener('pagehide', () => this.persist());
    this.refresh();
  }

  private setConnection(text: string): void {
    this.root.querySelector('.demo-badge')!.textContent = text;
  }

  private select(id: string | undefined): void {
    this.controller?.abort();
    this.activeId = id;
    this.toggleSidebar(false);
    this.refresh();
    if (!this.controller) this.input.focus();
  }

  private toggleSidebar(open: boolean): void {
    this.root.classList.toggle('sidebar-open', open);
    this.root.querySelector('.menu-button')!.setAttribute('aria-expanded', String(open));
  }

  private refresh(): void {
    const chat = this.chats.find(c => c.id === this.activeId);
    this.title.textContent = chat?.title ?? 'Новый диалог';
    this.view.render(chat);
    this.renderHistory();
  }

  private renderHistory(): void {
    this.history.replaceChildren();
    if (!this.chats.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.innerHTML = `${Icons.get('chat')}<p>Здесь будут ваши диалоги</p><span>Начните с первого вопроса</span>`;
      this.history.append(empty);
    }
    [...this.chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).forEach(chat => {
      const row = document.createElement('div');
      row.className = `history-row${chat.id === this.activeId ? ' active' : ''}`;
      const button = document.createElement('button');
      button.className = 'history-item';
      button.innerHTML = `${Icons.get('chat')}<span></span>`;
      button.querySelector('span')!.textContent = chat.title;
      button.title = chat.title;
      if (chat.id === this.activeId) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => this.select(chat.id));
      const remove = document.createElement('button');
      remove.className = 'delete-chat icon-button';
      remove.innerHTML = Icons.get('trash');
      remove.setAttribute('aria-label', `Удалить диалог «${chat.title}»`);
      remove.addEventListener('click', () => {
        if (chat.id === this.activeId) { this.controller?.abort(); this.activeId = undefined; }
        this.chats.splice(this.chats.indexOf(chat), 1);
        this.persist();
        this.refresh();
      });
      row.append(button, remove);
      this.history.append(row);
    });
  }

  private persist(): void {
    this.notice.textContent = this.storage.save(this.chats) ? '' : 'Не удалось сохранить историю в браузере. Текущий диалог доступен до закрытия страницы.';
  }

  private async send(text: string): Promise<void> {
    if (this.controller) return;
    let chat = this.chats.find(c => c.id === this.activeId);
    if (!chat) {
      chat = { id: crypto.randomUUID(), title: text.slice(0, 52), updatedAt: new Date().toISOString(), messages: [] };
      this.chats.push(chat);
      this.activeId = chat.id;
    }
    chat.updatedAt = new Date().toISOString();
    chat.messages.push({ id: crypto.randomUUID(), role: 'user', content: text, createdAt: chat.updatedAt });
    const context = [...chat.messages];
    const response: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: chat.updatedAt, mode: this.service.mode ?? 'local' };
    chat.messages.push(response);
    const controller = new AbortController();
    this.controller = controller;
    this.input.setBusy(true);
    this.liveStatus.textContent = 'Помощник формирует ответ.';
    this.persist();
    this.refresh();
    try {
      for await (const chunk of this.service.stream(context, controller.signal, chat.state)) {
        controller.signal.throwIfAborted();
        if (typeof chunk === 'string') response.content += chunk;
        else {
          response.content = chunk.content;
          response.sources = chunk.sources;
          response.choices = chunk.choices;
          response.clarification = chunk.clarification;
          chat.state = chunk.state;
        }
        if (this.activeId === chat.id) this.view.updateMessage(response);
      }
      this.liveStatus.textContent = 'Ответ готов.';
      if (this.service.mode !== 'demo') this.setConnection('Сервис подключён');
    } catch (error) {
      if (controller.signal.aborted) {
        response.content = response.content.trimEnd() + '\n\n[Ответ остановлен]';
        this.liveStatus.textContent = 'Ответ остановлен.';
      } else {
        response.content = response.content.trimEnd() + '\n\n' + (error instanceof Error ? error.message : 'Не удалось получить ответ. Попробуйте отправить вопрос ещё раз.');
        if (this.service.mode !== 'demo') this.setConnection('Ошибка запроса');
        this.liveStatus.textContent = 'Не удалось получить ответ.';
        console.error('Chat response failed', error);
      }
    } finally {
      if (this.activeId === chat.id) this.view.updateMessage(response);
      this.controller = undefined;
      this.input.setBusy(false);
      this.persist();
      this.input.focus();
    }
  }
}
