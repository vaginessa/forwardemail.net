/*
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file incorporates work covered by the following copyright and
 * permission notice:
 *
 *   WildDuck Mail Agent is licensed under the European Union Public License 1.2 or later.
 *   https://github.com/nodemailer/wildduck
 */

const Aliases = require('#models/aliases');
const IMAPError = require('#helpers/imap-error');
const Mailboxes = require('#models/mailboxes');
const config = require('#config');
const i18n = require('#helpers/i18n');
const refineAndLogError = require('#helpers/refine-and-log-error');

async function onGetQuotaRoot(path, session, fn) {
  this.logger.debug('GETQUOTAROOT', { path, session });

  try {
    if (this?.constructor?.name === 'IMAP') {
      try {
        const data = await this.wsp.request({
          action: 'get_quota_root',
          session: {
            id: session.id,
            user: session.user,
            remoteAddress: session.remoteAddress
          },
          path
        });
        fn(null, ...data);
      } catch (err) {
        fn(err);
      }

      return;
    }

    await this.refreshSession(session, 'GETQUOTAROOT');

    const mailbox = await Mailboxes.findOne(this, session, {
      path
    });

    if (!mailbox)
      throw new IMAPError(
        i18n.translate('IMAP_MAILBOX_DOES_NOT_EXIST', session.user.locale),
        {
          imapResponse: 'NONEXISTENT'
        }
      );

    const storageUsed = await Aliases.getStorageUsed({
      id: session.user.alias_id,
      domain: session.user.domain_id,
      locale: session.user.locale
    });

    fn(null, {
      root: '',
      quota: config.maxQuotaPerAlias,
      storageUsed
    });
  } catch (err) {
    // NOTE: wildduck uses `imapResponse` so we are keeping it consistent
    if (err.imapResponse) {
      this.logger.error(err, { path, session });
      return fn(null, err.imapResponse);
    }

    fn(refineAndLogError(err, session, true));
  }
}

module.exports = onGetQuotaRoot;
