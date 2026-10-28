import { replace } from '../../lib/dom';
import type { ViewContext } from '../main';
import { emptyState, linkButton } from '../ui';

export async function renderNotFound(ctx: ViewContext, message = 'This page does not exist.'): Promise<void> {
  replace(ctx.root, emptyState({ icon: 'alert', title: 'Not found', text: message, action: linkButton('Go to overview', '#/overview', { variant: 'primary' }) }));
}
