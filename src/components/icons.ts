const paths: Record<string, string> = {
  heat: '<path d="M8 3c3 4-2 5 0 9M13 3c3 4-2 5 0 9M18 3c3 4-2 5 0 9"/><path d="M4 16h16v5H4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"/>',
  tool: '<path d="m14 6 4 4 3-3a7 7 0 0 1-9 8L5 22l-3-3 7-7a7 7 0 0 1 8-9Z"/>',
  pipes: '<path d="M4 4h7v5h5V4h5v10H11v7H4z"/>',
  gauge: '<path d="M4 19a9 9 0 1 1 16 0Z"/><path d="m12 13 4-5M5 13h2M17 13h2M12 5v2"/>',
  book: '<path d="M12 6c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V5c-4-1-7-1-10 1Zm0 0v15"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
};

export class Icons {
  static get(name: string): string {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.chat}</svg>`;
  }
}
