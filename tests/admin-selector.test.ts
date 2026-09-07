import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ADMIN_HTML } from '../src/api/admin/ui';

function panel(preferences: Record<string, string> = {}) {
  const storage = new Map(Object.entries(preferences));
  const script = ADMIN_HTML.match(/<script>\s*(function memoryAdmin\(\)[\s\S]*?)<\/script>/)![1];
  const app = runInNewContext(script + '\nmemoryAdmin()', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value) },
    location: { origin: 'https://aelios.test' },
    document: { documentElement: { dataset: {} } },
    window: { setTimeout() {} }
  });
  app.icons = () => {};
  app.apiKey = 'owner';
  app.request = async (path: string) => path === '/api/gateway/config' ? {
    identities: [
      { slug: 'danjiu', readNamespaces: ['danjiu', 'shared'] },
      { slug: 'ningjiao', namespace: 'ning', readNamespaces: [] }
    ]
  } : { data: [] };
  return { app, storage };
}

test('first visit selects the first assistant; selecting another uses its write space', async () => {
  const { app, storage } = panel();
  await app.init();
  assert.equal(app.selectedIdentity, 'danjiu');
  assert.equal(app.namespace, 'danjiu');
  await app.selectIdentity('ningjiao');
  assert.equal(app.namespace, 'ning');
  assert.match(app.spaceDescription(), /召回：已关闭/);
  assert.equal(storage.get('aelios.admin.namespace'), 'ning');
});

test('read spaces remain individually selectable and survive a reload', async () => {
  const { app } = panel({ 'aelios.admin.identity': 'danjiu', 'aelios.admin.namespace': 'shared' });
  await app.init();
  assert.equal(app.namespace, 'shared');
  assert.equal(JSON.stringify(app.identitySpaces().map((s: any) => s.name)), '["danjiu","shared"]');
  assert.equal(app.gwIdentities.length, 0); // Reading never overwrites an unsaved settings editor.
});

test('legacy and explicitly chosen custom spaces are preserved', async () => {
  for (const prefs of [
    { 'aelios.admin.namespace': 'old-library' },
    { 'aelios.admin.namespace': 'default', 'aelios.admin.identity': '' }
  ]) {
    const { app } = panel(prefs);
    await app.init();
    assert.equal(app.namespace, prefs['aelios.admin.namespace']);
    assert.equal(app.selectedIdentity, '');
  }
});

test('switching spaces clears selections and reloads the visible diary', async () => {
  const { app } = panel();
  app.page = 'diary'; app.diaryDailies = [{ title: 'old diary' }];
  app.worldSelection = { old: true }; app.dreamHarvest = { old: true };
  app.request = async (path: string) => path.startsWith('/admin/diary') ? {
    data: { dailies: [{ title: 'new diary' }] }
  } : { data: {} };
  await app.switchSpace('ning');
  assert.equal(app.diaryDailies[0].title, 'new diary');
  assert.equal(Object.keys(app.worldSelection).length, 0);
  assert.equal(app.dreamHarvest, null);
});

test('late responses and errors cannot restore an old space after A-B-A switching', async () => {
  for (const fail of [false, true]) {
    const { app } = panel();
    app.namespace = 'a';
    let finish: (value: any) => void = () => {};
    let reject: (value: any) => void = () => {};
    app.request = () => new Promise((resolve, fail) => { finish = resolve; reject = fail; });
    const previous = app.loadWorldFacts();
    app.request = async () => ({ data: [] });
    await app.switchSpace('b'); await app.switchSpace('a');
    app.worldItems = [{ content: 'fresh data' }];
    if (fail) reject(new Error('old request failed'));
    else finish({ data: [{ content: 'stale data' }] });
    await previous;
    assert.equal(app.worldItems[0].content, 'fresh data');
    assert.equal(app.toast, '');
  }
});

test('saving the first token loads identities instead of locking the panel to default', async () => {
  const { app } = panel();
  await app.saveToken();
  assert.equal(app.selectedIdentity, 'danjiu');
  assert.equal(app.namespace, 'danjiu');
});
