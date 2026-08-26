import type {
  SceneStatusRailController,
  SceneStatusRailModel,
  SceneStatusRailMountOptions,
  SceneStatusRailSection,
} from '@tavernnext/domain';

let railSequence = 0;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendFields(target: HTMLElement, fields: Array<{ label: string; value: string }>): void {
  for (const field of fields) {
    const item = element('div');
    item.append(element('span', undefined, field.label), element('strong', undefined, field.value));
    target.append(item);
  }
}

function renderSection(section: SceneStatusRailSection): HTMLElement {
  if (section.kind === 'identity') {
    const node = element('section', 'tn-status-rail-identity');
    const copy = element('div');
    if (section.overline !== undefined) copy.append(element('span', undefined, section.overline));
    copy.append(element('strong', undefined, section.title));
    if (section.subtitle !== undefined) copy.append(element('small', undefined, section.subtitle));
    node.append(copy);
    if (section.badge !== undefined) {
      const badge = element('b');
      if (section.badge.label !== undefined) badge.append(element('small', undefined, section.badge.label));
      badge.append(document.createTextNode(section.badge.value));
      node.append(badge);
    }
    return node;
  }

  if (section.kind === 'fields') {
    const node = element('section', 'tn-status-rail-fields');
    if (section.title !== undefined) node.append(element('h3', undefined, section.title));
    const grid = element('div');
    appendFields(grid, section.fields);
    node.append(grid);
    return node;
  }

  if (section.kind === 'meters') {
    const node = element('section', 'tn-status-rail-meters');
    for (const meter of section.meters) {
      const item = element('div', 'tn-status-rail-meter');
      if (meter.tone !== undefined) item.dataset.tone = meter.tone.replace(/[^a-z0-9_-]/gi, '');
      const heading = element('div');
      heading.append(
        element('span', undefined, meter.label),
        element('strong', undefined, meter.displayValue ?? `${meter.value} / ${meter.maximum}`),
      );
      const track = element('div', 'tn-status-rail-meter-track');
      const fill = element('i');
      const ratio = meter.maximum > 0 ? meter.value / meter.maximum * 100 : 0;
      fill.style.width = `${Math.max(0, Math.min(100, ratio))}%`;
      track.append(fill);
      item.append(heading, track);
      node.append(item);
    }
    return node;
  }

  if (section.kind === 'stats') {
    const node = element('section', 'tn-status-rail-section');
    if (section.title !== undefined || section.aside !== undefined) {
      const header = element('header');
      if (section.title !== undefined) header.append(element('strong', undefined, section.title));
      if (section.aside !== undefined) header.append(element('span', undefined, section.aside));
      node.append(header);
    }
    const stats = element('div', 'tn-status-rail-stats');
    for (const stat of section.stats) {
      const item = element('div');
      item.append(element('span', undefined, stat.label), element('strong', undefined, stat.value));
      if (stat.action !== undefined) {
        const button = element('button', undefined, stat.action.label);
        button.type = 'button';
        button.dataset.tnStatusRailAction = stat.action.id;
        button.disabled = stat.action.disabled === true;
        button.setAttribute('aria-label', stat.action.ariaLabel ?? stat.action.label);
        item.append(button);
      }
      stats.append(item);
    }
    node.append(stats);
    return node;
  }

  const node = element('section', 'tn-status-rail-section');
  if (section.title !== undefined) {
    const header = element('header');
    header.append(element('strong', undefined, section.title));
    node.append(header);
  }
  if (section.cards.length === 0) {
    node.append(element('div', 'tn-status-rail-empty', section.emptyText));
    return node;
  }
  const list = element('div', 'tn-status-rail-cards');
  for (const card of section.cards) {
    const item = element('article', 'tn-status-rail-card');
    item.append(element('strong', undefined, card.title));
    if (card.fields.length > 0) {
      const description = element('dl');
      for (const field of card.fields) {
        const row = element('div');
        row.append(element('dt', undefined, field.label), element('dd', undefined, field.value));
        description.append(row);
      }
      item.append(description);
    }
    list.append(item);
  }
  node.append(list);
  return node;
}

export function mountSceneStatusRail(options: SceneStatusRailMountOptions): SceneStatusRailController {
  const railId = `tn-scene-status-rail-${railSequence += 1}`;
  const rail = element('aside', 'tn-status-rail');
  rail.id = railId;
  const backdrop = element('button', 'tn-status-rail-backdrop');
  backdrop.type = 'button';
  backdrop.setAttribute('aria-label', options.model.closeLabel ?? 'Close status panel');
  const trigger = options.trigger;
  let model = options.model;
  let activeTab = options.activeTab ?? model.tabs[0]?.id ?? '';
  let open = options.open === true;
  let destroyed = false;

  options.container.classList.add('tn-status-rail-layout');
  options.container.append(rail, backdrop);
  if (trigger !== undefined) {
    trigger.classList.add('tn-status-rail-toggle');
    trigger.setAttribute('aria-controls', railId);
  }

  const selectedTab = () => model.tabs.find((tab) => tab.id === activeTab) ?? model.tabs[0];
  const render = () => {
    const current = selectedTab();
    activeTab = current?.id ?? '';
    rail.setAttribute('aria-label', model.ariaLabel ?? 'Scene status');
    const header = element('header', 'tn-status-rail-header');
    const heading = element('div');
    if (model.overline !== undefined) heading.append(element('span', undefined, model.overline));
    heading.append(element('strong', undefined, model.title));
    const close = element('button', undefined, '×');
    close.type = 'button';
    close.dataset.tnStatusRailClose = '';
    close.setAttribute('aria-label', model.closeLabel ?? 'Close status panel');
    header.append(heading, close);

    const tabs = element('nav', 'tn-status-rail-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', model.ariaLabel ?? 'Scene status pages');
    for (const tab of model.tabs) {
      const button = element('button', tab.id === activeTab ? 'active' : undefined, tab.label);
      button.type = 'button';
      button.id = `${railId}-tab-${tab.id}`;
      button.dataset.tnStatusRailTab = tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.id === activeTab));
      tabs.append(button);
    }

    const body = element('section', 'tn-status-rail-body');
    body.setAttribute('role', 'tabpanel');
    if (current !== undefined) {
      body.setAttribute('aria-labelledby', `${railId}-tab-${current.id}`);
      for (const section of current.sections) body.append(renderSection(section));
    }
    rail.replaceChildren(header, tabs, body);
    backdrop.setAttribute('aria-label', model.closeLabel ?? 'Close status panel');
  };

  const setOpen = (next: boolean, restoreFocus = false) => {
    open = next;
    options.container.classList.toggle('tn-status-rail-open', open);
    trigger?.setAttribute('aria-expanded', String(open));
    options.onOpenChange?.(open);
    if (restoreFocus) trigger?.focus();
  };

  const click = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('[data-tn-status-rail-close]') !== null) {
      setOpen(false, true);
      return;
    }
    const tab = target.closest<HTMLElement>('[data-tn-status-rail-tab]')?.dataset.tnStatusRailTab;
    if (tab !== undefined && model.tabs.some((item) => item.id === tab)) {
      activeTab = tab;
      render();
      options.onTabChange?.(tab);
      return;
    }
    const actionButton = target.closest<HTMLButtonElement>('[data-tn-status-rail-action]');
    const action = actionButton?.dataset.tnStatusRailAction;
    if (action === undefined || actionButton === null || options.onAction === undefined) return;
    actionButton.disabled = true;
    actionButton.setAttribute('aria-busy', 'true');
    void Promise.resolve(options.onAction(action)).catch(() => undefined).finally(() => {
      if (destroyed) return;
      actionButton.removeAttribute('aria-busy');
      actionButton.disabled = false;
    });
  };
  const triggerClick = () => setOpen(true);
  const backdropClick = () => setOpen(false, true);
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) setOpen(false, true);
  };
  rail.addEventListener('click', click);
  backdrop.addEventListener('click', backdropClick);
  trigger?.addEventListener('click', triggerClick);
  document.addEventListener('keydown', keydown);
  render();
  setOpen(open);

  return {
    update(nextModel, nextActiveTab) {
      if (destroyed) return;
      model = nextModel;
      if (nextActiveTab !== undefined) activeTab = nextActiveTab;
      render();
    },
    setOpen,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      rail.removeEventListener('click', click);
      backdrop.removeEventListener('click', backdropClick);
      trigger?.removeEventListener('click', triggerClick);
      document.removeEventListener('keydown', keydown);
      trigger?.classList.remove('tn-status-rail-toggle');
      trigger?.removeAttribute('aria-controls');
      trigger?.removeAttribute('aria-expanded');
      options.container.classList.remove('tn-status-rail-layout', 'tn-status-rail-open');
      rail.remove();
      backdrop.remove();
    },
  };
}
