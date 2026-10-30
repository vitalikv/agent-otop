import { Icons } from './icons';

export class MessageInput {
  readonly element = document.createElement('form');
  private readonly textarea: HTMLTextAreaElement;
  private readonly button: HTMLButtonElement;
  private busy = false;

  constructor(onSend: (text: string) => void, onStop: () => void) {
    this.element.className = 'composer';
    this.element.innerHTML = `<label class="sr-only" for="message">Ваш вопрос по отоплению</label><textarea id="message" rows="1" maxlength="8000" placeholder="Спросите что-нибудь об отоплении…"></textarea><div class="composer-bottom"><span>Enter — отправить <span class="key-divider">/</span> Shift + Enter — новая строка</span><button class="send-button" type="submit" aria-label="Отправить сообщение">${Icons.get('arrow')}</button></div>`;
    this.textarea = this.element.querySelector('textarea')!;
    this.button = this.element.querySelector('button')!;
    this.element.addEventListener('submit', event => {
      event.preventDefault();
      if (this.busy) { onStop(); return; }
      const text = this.textarea.value.trim();
      if (!text) return;
      this.textarea.value = '';
      this.resize();
      onSend(text);
    });
    this.textarea.addEventListener('input', () => this.resize());
    this.textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!this.busy) this.element.requestSubmit();
      }
    });
    this.resize();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.textarea.disabled = busy;
    this.button.innerHTML = Icons.get(busy ? 'stop' : 'arrow');
    this.button.setAttribute('aria-label', busy ? 'Остановить ответ' : 'Отправить сообщение');
    this.button.title = busy ? 'Остановить ответ' : 'Отправить сообщение';
    this.button.disabled = !busy && !this.textarea.value.trim();
  }

  focus(): void { this.textarea.focus(); }

  private resize(): void {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 180)}px`;
    this.button.disabled = !this.busy && !this.textarea.value.trim();
  }
}
