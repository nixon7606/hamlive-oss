/**
 * Tests for chat.ts helper functions and UI formatting.
 * Tests the pure logic functions, not the DOM-heavy rendering (which
 * requires a full browser environment).
 */

// Set up jsdom-compatible DOM before anything else
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="test"></div></body></html>', {
  url: 'http://localhost:3000',
  pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.customElements = dom.window.customElements;
global.setTimeout = dom.window.setTimeout;
global.clearTimeout = dom.window.clearTimeout;
global.requestAnimationFrame = dom.window.requestAnimationFrame;

// Mock serverInfo
global.serverInfo = {};

// Mock localStorage
const store = {};
global.localStorage = {
  getItem: jest.fn((key) => store[key] || null),
  setItem: jest.fn((key, val) => { store[key] = val; }),
  removeItem: jest.fn((key) => { delete store[key]; }),
  clear: jest.fn(() => { Object.keys(store).forEach(k => delete store[k]); })
};

describe('ChatWidget static helpers', () => {
  let ChatWidget;

  beforeAll(async () => {
    // Module will register the custom element
    const mod = require('../../client/dist/public/js/lib/chat');
    // After import, the ChatWidget should be defined
    // The TS compiles to ES module with export; the dist file may need different handling
    ChatWidget = mod.ChatWidget || mod.default;
  });

  afterAll(() => {
    // Clean up custom element registration
    if (customElements.get('hl-chat')) {
      // Can't un-define, but we can test around it
    }
  });

  test('ChatWidget class exists', () => {
    expect(ChatWidget).toBeDefined();
  });

  test('ChatWidget extends HTMLElement', () => {
    // Check prototype chain
    expect(ChatWidget.prototype instanceof HTMLElement).toBe(true);
  });

  test('ChatWidget can be instantiated', () => {
    const widget = document.createElement('hl-chat');
    expect(widget).toBeDefined();
    expect(widget instanceof ChatWidget).toBe(true);
  });

  test('connectedCallback renders template when chat enabled', () => {
    serverInfo.chat = true;
    const widget = document.createElement('hl-chat');
    document.body.appendChild(widget);

    expect(widget.innerHTML).toContain('chat-widget');
    expect(widget.innerHTML).toContain('chat-messages');
    expect(widget.innerHTML).toContain('chat-text-input');

    document.body.removeChild(widget);
  });

  test('connectedCallback clears content when chat disabled', () => {
    serverInfo.chat = false;
    const widget = document.createElement('hl-chat');
    document.body.appendChild(widget);

    expect(widget.innerHTML).toBe('');

    document.body.removeChild(widget);
    serverInfo.chat = true;
  });

  test('widget has correct CSS class', () => {
    const widget = document.createElement('hl-chat');
    expect(widget.style.display).toBe('block');
    expect(widget.style.height).toBe('100%');
  });

  test('offline class toggles correctly', () => {
    const widget = document.createElement('hl-chat');
    expect(widget.classList.contains('offline')).toBe(false);

    widget.online = false;
    expect(widget.classList.contains('offline')).toBe(true);

    widget.online = true;
    expect(widget.classList.contains('offline')).toBe(false);
  });
});