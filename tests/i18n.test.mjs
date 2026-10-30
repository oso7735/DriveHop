import test from 'node:test';
import assert from 'node:assert/strict';
import {configureLanguage, currentLanguage, translate, translateChildren} from '../app/drivehop/i18n.js';

test('matches Spanish PS5 locales and preserves game titles', () => {
  assert.equal(configureLanguage('es-419'), 'es');
  assert.equal(currentLanguage(), 'es');
  assert.equal(translate('Internal SSD'), 'SSD interno');
  assert.equal(translate('12 games'), '12 juegos');
  assert.equal(translate('Ratchet & Clank: Rift Apart'), 'Ratchet & Clank: Rift Apart');
  assert.deepEqual(translateChildren(['Copy', ' ', 2, ' games']), ['Copiar', ' ', 2, ' juegos']);
});

test('falls back to English for languages without a catalog', () => {
  assert.equal(configureLanguage('fr-CA'), 'en');
  assert.equal(translate('Copy'), 'Copy');
});
