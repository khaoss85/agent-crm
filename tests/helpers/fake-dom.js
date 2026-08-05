// Minimal, dependency-free DOM stand-in — just enough to exercise the
// generated-module Admin view code (createElement + textContent/setAttribute/
// .value/.checked + append/remove + events). It is deliberately faithful about
// textContent (concatenation of a node's own text and its children) so that an
// XSS assertion — "hostile value is text, never markup" — is meaningful.

class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.attributes = Object.create(null);
    this._text = '';
    this.listeners = Object.create(null);
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
      toggle: (c, force) => {
        const has = force === undefined ? !this.classList._set.has(c) : force;
        if (has) this.classList._set.add(c);
        else this.classList._set.delete(c);
        return has;
      },
    };
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? '' : String(value);
    this.childNodes = [];
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent).join('');
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  get className() {
    return [...this.classList._set].join(' ');
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    return child;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }

  // Recursively collect descendants by tag name (test helper).
  findAll(tagName) {
    const wanted = tagName.toUpperCase();
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.tagName === wanted) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  findByText(tagName, text) {
    return this.findAll(tagName).find((node) => node.textContent.includes(text));
  }
}

export function createFakeDocument() {
  return {
    createElement: (tag) => new FakeNode(tag),
  };
}

export function createMount() {
  return new FakeNode('section');
}
