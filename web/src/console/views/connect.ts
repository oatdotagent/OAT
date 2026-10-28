import { ApiError, type Api } from '../../lib/api';
import { h, icon, replace } from '../../lib/dom';
import { looksLikeToken, setToken, clearToken } from '../../lib/session';
import { alert, button, card, field, withBusy } from '../ui';

export function renderConnect(opts: { api: Api; root: HTMLElement; signal: AbortSignal; notice?: string; onConnected: () => void }): void {
  const input = h('input', {
    class: 'input',
    attrs: { type: 'password', name: 'token', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'oat_…', inputmode: 'text' },
  });
  const status = h('div', { attrs: { 'aria-live': 'polite' } });
  const submit = button('Connect', { variant: 'primary', type: 'submit', icon: 'key' });

  const form = h(
    'form',
    {
      attrs: { novalidate: true },
      on: {
        submit: (e) => {
          e.preventDefault();
          const token = input.value.trim();
          if (!looksLikeToken(token)) {
            input.setAttribute('aria-invalid', 'true');
            replace(status, alert('err', h('p', {}, 'That does not look like an API token (16–512 characters, no spaces).')));
            input.focus();
            return;
          }
          input.removeAttribute('aria-invalid');
          void withBusy(submit, 'Connecting…', async () => {
            setToken(token);
            try {
              await opts.api.me();
              if (!opts.signal.aborted) opts.onConnected();
            } catch (err) {
              clearToken();
              const msg =
                err instanceof ApiError && err.status === 401
                  ? 'The server did not accept this token.'
                  : err instanceof ApiError && err.status === 0
                    ? 'Could not reach the API server. Is the backend running?'
                    : `Unexpected error: ${(err as Error).message}`;
              input.setAttribute('aria-invalid', 'true');
              replace(status, alert('err', h('p', {}, msg)));
            }
          });
        },
      },
    },
    opts.notice ? alert('warn', h('p', {}, opts.notice)) : null,
    field('API token', input, 'Kept only in this browser tab (session storage) and sent only to this server.'),
    status,
    submit,
  );

  replace(
    opts.root,
    h(
      'div',
      { class: 'connect' },
      card(
        { title: 'Connect to your server', icon: 'key' },
        h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Sign in with the API token issued for your user. Provider API keys stay on the server and are never sent to the browser.'), form),
      ),
      h(
        'div',
        { class: 'card section-gap stack' },
        h('h2', { class: 'card__title' }, icon('info'), 'Need a token?'),
        h('p', { class: 'muted' }, 'An operator creates one on the server and adds its hash to AUTH_TOKENS:'),
        h('div', { class: 'code' }, h('pre', {}, h('code', {}, 'npm run token:create -- <your-user> user'))),
        h('p', { class: 'muted' }, 'See ', h('a', { attrs: { href: '/#docs' } }, 'Getting started'), ' for the full setup.'),
      ),
    ),
  );
  input.focus();
}
