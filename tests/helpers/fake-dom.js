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

  // Real-DOM Node.contains: self, descendants, and (unlike the real one)
  // nothing else — null and detached subtrees never match.
  contains(node) {
    let current = node ?? null;
    while (current) {
      if (current === this) return true;
      current = current.parentNode ?? null;
    }
    return false;
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

  // Keyboard-focus stand-in: production view code may call .focus() after a
  // repaint replaced the focused node. The flag lets a test assert where
  // focus landed; there is no focus ring, trap, or activeElement tracking.
  focus() {
    this.__focused = true;
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

  // Minimal real-DOM surface: production view code must use querySelector
  // (present on a real Element), never findAll (which exists only here).
  // Supports `tag`, `tag[attr="value"]` and `.class` — nothing more.
  querySelector(selector) {
    const match = String(selector).match(/^([a-zA-Z][a-zA-Z0-9]*)?(?:\[([a-zA-Z-]+)="([^"]*)"\])?$/) ?? null;
    const classMatch = !match ? String(selector).match(/^\.([a-zA-Z0-9_-]+)$/) : null;
    if (!match && !classMatch) return null;
    const wantedTag = match?.[1]?.toUpperCase() ?? null;
    const wantedAttr = match?.[2] ?? null;
    const wantedValue = match?.[3] ?? null;
    const wantedClass = classMatch?.[1] ?? null;
    // Depth-first pre-order, like document order in a real Element.
    const walk = (node) => {
      for (const child of node.childNodes) {
        const tagOk = !wantedTag || child.tagName === wantedTag;
        const attrOk = !wantedAttr || child.getAttribute(wantedAttr) === wantedValue;
        const classOk = !wantedClass || (child.getAttribute('class') ?? '').split(/\s+/).includes(wantedClass);
        if (tagOk && attrOk && classOk) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  findByText(tagName, text) {
    return this.findAll(tagName).find((node) => node.textContent.includes(text));
  }
}

export function createFakeDocument() {
  return {
    createElement: (tag) => new FakeNode(tag),
    // Namespace-aware creation for inline SVG icons (BO-F6-01): the fake
    // node only needs the tag — namespaces never affect the assertions.
    createElementNS: (_ns, tag) => new FakeNode(tag),
  };
}

export function createMount() {
  return new FakeNode('section');
}
