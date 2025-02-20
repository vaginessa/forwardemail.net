/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const path = require('node:path');

const Boom = require('@hapi/boom');
const Router = require('@koa/router');
const dashify = require('dashify');
const isSANB = require('is-string-and-not-blank');
const pWaitFor = require('p-wait-for');
const pTimeout = require('p-timeout');
const ms = require('ms');
const pug = require('pug');
const puppeteer = require('puppeteer');
const render = require('koa-views-render');
const revHash = require('rev-hash');
const { parse } = require('node-html-parser');

// dynamically import mermaid cli
let parseMMD;

import('@mermaid-js/mermaid-cli').then((obj) => {
  parseMMD = obj.parseMMD;
});

const admin = require('./admin');
const auth = require('./auth');
const myAccount = require('./my-account');
const otp = require('./otp');

const config = require('#config');
const policies = require('#helpers/policies');
const rateLimit = require('#helpers/rate-limit');
const { decrypt } = require('#helpers/encrypt-decrypt');
const { developerDocs, nsProviders, platforms } = require('#config/utilities');
const { web } = require('#controllers');

const filePath = path.join(config.views.root, '_tti.pug');

const router = new Router();

router
  // status page crawlers often send `HEAD /` requests
  .get('/', (ctx, next) => {
    if (ctx.method === 'HEAD') {
      ctx.body = 'OK';
      return;
    }

    return next();
  })
  // sitemap
  .get('/sitemap.xml', web.sitemap)
  // report URI support (not locale specific)
  .post('/report', web.report)

  // mermaid charts
  // TODO: once svg fixed we can use that instead
  // <https://github.com/mermaid-js/mermaid-cli/issues/632>
  .get('/mermaid.png', async (ctx) => {
    let browser;
    try {
      if (!isSANB(ctx.query.code)) throw new Error('Code missing');
      if (ctx.query.theme !== 'dark' && ctx.query.theme !== 'default')
        throw new Error('Theme invalid');

      const code = decrypt(ctx.query.code);
      const hash = revHash(`${ctx.query.theme}:${code}`);

      if (global.mermaid && global.mermaid[hash]) {
        ctx.type = 'image/png';
        ctx.body = global.mermaid[hash];
        return;
      }

      // attempt to find in redis cache a buffer
      try {
        const buffer = await pTimeout(
          ctx.client.getBuffer(`buffer:${hash}`),
          1000
        );
        if (buffer) {
          if (!global.mermaid) global.mermaid = {};
          global.mermaid[hash] = buffer;
          ctx.type = 'image/png';
          ctx.body = buffer;
          return;
        }
      } catch (err) {
        ctx.logger.error(err);
      }

      if (!parseMMD)
        await pWaitFor(() => Boolean(parseMMD), { timeout: ms('5s') });

      browser = await puppeteer.launch();
      const svg = await parseMMD(browser, code, 'png', {
        viewport: {
          width: 3000,
          height: 3000,
          deviceScaleFactor: 2
        },
        mermaidConfig: {
          diagramPadding: 100,
          theme: ctx.query.theme
        },
        backgroundColor: ctx.query.theme === 'default' ? 'white' : 'transparent'
      });
      if (!global.mermaid) global.mermaid = {};
      global.mermaid[hash] = svg;
      ctx.type = 'image/png';
      ctx.body = svg;
      // store buffer in cache
      try {
        await ctx.client.set(`buffer:${hash}`, svg);
      } catch (err) {
        ctx.logger.error(err);
      }
    } catch (err) {
      if (browser)
        browser
          .close()
          .then()
          .catch((err) => ctx.logger.error(err));
      ctx.logger.error(err);
      throw Boom.badRequest(ctx.translateError('UNKNOWN_ERROR'));
    }
  });

const localeRouter = new Router({ prefix: '/:locale' });

localeRouter
  // add HTTP Link header to GET requests
  // for canonical urls for search engines
  // <https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls#rel-canonical-header-method>
  .use((ctx, next) => {
    if (ctx.method === 'GET')
      ctx.set('Link', `<${config.urls.web}${ctx.path}>; rel="canonical"`);

    return next();
  })
  // svg dynamically generated og images
  // .get('(.*).(png|svg)', web.generateOpenGraphImage)
  .get('(.*).(png)', web.generateOpenGraphImage)
  .get('/', web.auth.homeOrDomains)
  .post(
    '/',
    web.myAccount.retrieveDomains,
    policies.ensureTurnstile,
    rateLimit(50, 'onboard'),
    web.onboard
  )

  .get('/tti', (ctx, next) => {
    if (ctx.accepts('html')) return next();
    const html = pug.renderFile(filePath, {
      ...ctx.state,
      ctx: {
        pathWithoutLocale:
          ctx.get('Referrer') === `${config.urls.web}/${ctx.locale}`
            ? '/'
            : ctx.pathWithoutLocale
      }
    });
    ctx.body = html;
  })

  // denylist removal (only 5 requests per 24 hours and removal is instant for paid users)
  .get(
    '/denylist',
    policies.ensureLoggedIn,
    policies.ensureOtp,
    web.myAccount.ensureNotBanned,
    render('denylist')
  )
  .post(
    '/denylist',
    policies.ensureLoggedIn,
    policies.ensureOtp,
    web.myAccount.ensureNotBanned,
    policies.ensureTurnstile,
    web.denylist.validate,
    rateLimit(5, 'denylist'),
    web.denylist.remove
  )
  // recipient verification
  .get('/v/:text', web.recipientVerification)
  .get('/dashboard', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/my-account'));
  })
  .get('/features', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/private-business-email'));
  })
  .get('/pricing', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/private-business-email'));
  })
  .get(
    '/private-business-email',
    web.myAccount.retrieveDomains,
    web.myAccount.sortedDomains,
    render('pricing')
  )
  .get('/faq', web.myAccount.retrieveDomains, web.onboard, web.faq)
  .post(
    '/faq',
    web.myAccount.retrieveDomains,
    policies.ensureTurnstile,
    rateLimit(50, 'onboard'),
    web.onboard,
    web.auth.parseReturnOrRedirectTo,
    web.faq
  )
  .get('/api', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/email-api'));
  })
  .get('/email-forwarding-api', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/email-api'));
  })
  .get('/email-api', web.myAccount.retrieveDomains, web.api)
  .get(
    '/help',
    policies.ensureLoggedIn,
    policies.ensureOtp,
    web.myAccount.ensureNotBanned,
    render('help')
  )
  .post(
    '/help',
    policies.ensureLoggedIn,
    policies.ensureOtp,
    web.myAccount.ensureNotBanned,
    policies.ensureTurnstile,
    rateLimit(3, 'help'),
    web.help
  )
  .get('/about', render('about'))
  .get(
    '/domain-registration',
    web.myAccount.retrieveDomains,
    web.onboard,
    render('domain-registration')
  )
  .get('/free-disposable-addresses', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/disposable-addresses'));
  })
  .get(
    '/disposable-addresses',
    web.myAccount.retrieveDomains,
    web.onboard,
    render('disposable-addresses')
  )
  .get(
    '/reserved-email-addresses',
    web.reservedEmailAddresses,
    web.myAccount.retrieveDomains,
    web.onboard,
    render('reserved-email-addresses')
  )
  .get('/encrypted-email', (ctx) => {
    ctx.status = 301;
    ctx.redirect(
      ctx.state.l('/blog/docs/best-quantum-safe-encrypted-email-service')
    );
  })
  .get(
    '/free-email-webhooks',
    web.myAccount.retrieveDomains,
    web.onboard,
    render('free-email-webhooks')
  )
  .get(
    '/email-forwarding-regex-pattern-filter',
    web.myAccount.retrieveDomains,
    web.onboard,
    render('email-forwarding-regex-pattern-filter')
  )
  .get('/resources', render('resources'))
  .get('/guides', render('guides'))
  .get('/blog/docs', render('docs'))
  .get('/guides/send-mail-as-using-gmail', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/guides/send-mail-as-gmail-custom-domain'));
  })
  .get(
    '/guides/send-email-with-custom-domain-smtp',
    web.guides.sendEmailWithCustomDomainSMTP,
    render('guides/send-email-with-custom-domain-smtp')
  )
  .get(
    '/guides/send-mail-as-gmail-custom-domain',
    web.guides.sendMailAs,
    render('guides/send-mail-as-using-gmail')
  )
  .get(
    '/guides/port-25-blocked-by-isp-workaround',
    web.onboard,
    render('guides/port-25-blocked-by-isp-workaround')
  )
  .get('/donate', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/'));
  })
  .get('/terms', render('terms'))
  .get('/report-abuse', render('report-abuse'))
  .get('/privacy', render('privacy'))
  .get('/open-startup', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/'));
  })
  .get('/forgot-password', policies.ensureLoggedOut, render('forgot-password'))
  .post(
    '/forgot-password',
    policies.ensureLoggedOut,
    policies.ensureTurnstile,
    rateLimit(10, 'forgot password'),
    web.auth.forgotPassword
  )
  .get(
    '/ap/:domain_id/:alias_id/:encrypted_password',
    rateLimit(20, 'regenerate alias password'),
    web.regenerateAliasPassword
  )
  .get(
    '/reset-password/:token',
    policies.ensureLoggedOut,
    render('reset-password')
  )
  .post(
    '/reset-password/:token',
    policies.ensureLoggedOut,
    policies.ensureTurnstile,
    rateLimit(10, 'reset password'),
    web.auth.resetPassword
  )
  .get(
    config.verifyRoute,
    policies.ensureLoggedIn,
    web.auth.parseReturnOrRedirectTo,
    web.auth.verify
  )
  .post(
    config.verifyRoute,
    policies.ensureLoggedIn,
    web.auth.parseReturnOrRedirectTo,
    rateLimit(10, 'verify'),
    web.auth.verify
  )
  .get('/logout', web.auth.logout)
  .get(
    config.loginRoute,
    web.auth.parseReturnOrRedirectTo,
    web.auth.registerOrLogin
  )
  .post(
    config.loginRoute,
    policies.ensureTurnstile,
    rateLimit(50, 'login'),
    web.auth.login
  )
  .get(
    '/register',
    policies.ensureLoggedOut,
    web.auth.parseReturnOrRedirectTo,
    web.auth.registerOrLogin
  )
  .post(
    '/register',
    policies.ensureLoggedOut,
    policies.ensureTurnstile,
    rateLimit(5, 'create user'),
    web.auth.register
  );

for (const doc of developerDocs) {
  // legacy redirect
  localeRouter.get(doc.slug.replace('/blog/docs', '/docs'), (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l(doc.slug));
  });
  localeRouter.get(doc.slug, render(doc.slug.replace('/blog/', '')));
}

localeRouter.get('/docs/nodejs-spam-filter-contact-form', (ctx) => {
  ctx.status = 301;
  ctx.redirect(ctx.state.l('/blog/docs/best-email-spam-protection-filter'));
});

if (platforms.length > 0) {
  // legacy redirect
  localeRouter.get('/open-source', (ctx) => {
    ctx.status = 301;
    ctx.redirect(ctx.state.l('/blog/open-source'));
  });
  localeRouter.get('/blog/open-source', render('open-source'));
}

for (const platform of platforms) {
  // legacy redirect
  localeRouter.get(`/open-source/${dashify(platform)}-email-server`, (ctx) => {
    ctx.status = 301;
    ctx.redirect(
      ctx.state.l(`/blog/open-source/${dashify(platform)}-email-server`)
    );
  });
  localeRouter.get(
    `/blog/open-source/${dashify(platform)}-email-server`,
    (ctx, next) => {
      ctx.state.platform = platform;
      return next();
    },
    render('open-source')
  );
  // legacy redirect
  localeRouter.get(`/open-source/${dashify(platform)}-email-clients`, (ctx) => {
    ctx.status = 301;
    ctx.redirect(
      ctx.state.l(`/blog/open-source/${dashify(platform)}-email-clients`)
    );
  });
  localeRouter.get(
    `/blog/open-source/${dashify(platform)}-email-clients`,
    (ctx, next) => {
      ctx.state.platform = platform;
      return next();
    },
    render('open-source')
  );
}

// YouTube warns "site may be harmful" if it has a dot extension
// (e.g. "domains.com" -> "domains-com")
localeRouter.get('/guides/domains.com', (ctx) => {
  ctx.status = 301;
  ctx.redirect(ctx.state.l('/guides/domains-com'));
});
localeRouter.get('/guides/name.com', (ctx) => {
  ctx.status = 301;
  ctx.redirect(ctx.state.l('/guides/name-com'));
});

for (const provider of nsProviders) {
  localeRouter.get(
    `/guides/${provider.slug}`,
    (ctx, next) => {
      // set open graph data
      if (provider.video) ctx.state.video = provider.video;
      if (provider.gif) ctx.state.gif = provider.gif;

      // dynamically load the DNS Management by Registrar table from FAQ
      try {
        const html = pug.renderFile(
          path.join(config.views.root, 'faq', 'index.pug'),
          // make flash a noop so we don't interfere with messages/session
          {
            ...ctx.state,
            flash() {
              return {};
            }
          }
        );

        // expose it to the view
        const root = parse(html);
        ctx.state.modalFAQTable = root.querySelector(
          '#table-dns-management-by-registrar'
        ).outerHTML;
      } catch (err) {
        ctx.logger.error(err);
      }

      return next();
    },
    render('guides/provider')
  );
}

localeRouter.use(myAccount.routes()).use(admin.routes()).use(otp.routes());

router.use(auth.routes()).use(localeRouter.routes());

module.exports = router;
