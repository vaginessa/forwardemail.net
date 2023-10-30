/* istanbul ignore file */

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
const config = require('#config');
const refineAndLogError = require('#helpers/refine-and-log-error');

async function onGetQuota(path, session, fn) {
  this.logger.debug('GETQUOTA', { path, session });

  try {
    const { alias, db } = await this.refreshSession(session, 'GETQUOTA');

    // close the connection
    db.close();

    if (path !== '') return fn(null, 'NONEXISTENT');

    const storageUsed = await Aliases.getStorageUsed(alias);

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

module.exports = onGetQuota;
