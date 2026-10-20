'use client';

import '@/lib/i18n/init';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Header from './Header';
import Footer from './Footer';

const TRIAL_ENV = `CAS_ESIGN_BASE_URL=https://production.bankhub.dev
CAS_ESIGN_CLIENT_ID=trial-vendor-47de-86e8-7342f311028c
CAS_ESIGN_API_KEY=a0e6d612-b34e-11f1-a10d-02cf4c5ff398`;

const OWN_ENV = `CAS_ESIGN_CLIENT_ID=<client id>
CAS_ESIGN_API_KEY=<api key>`;

type TocItem = { id: string; labelKey: string; children?: TocItem[] };

const TOC: TocItem[] = [
  {
    id: 'bat-dau-nhanh',
    labelKey: 'openSourcePage.toc.quick',
    children: [
      { id: 'chay-local', labelKey: 'openSourcePage.toc.local' },
      { id: 'deploy-pm2', labelKey: 'openSourcePage.toc.pm2' },
      { id: 'deploy-cloudflare', labelKey: 'openSourcePage.toc.worker' },
    ],
  },
  { id: 'thuc-hien-ky', labelKey: 'openSourcePage.toc.sign' },
  {
    id: 'trien-khai-thuc-te',
    labelKey: 'openSourcePage.toc.production',
    children: [
      { id: 'dang-ky-vendor', labelKey: 'openSourcePage.toc.vendor' },
      { id: 'tao-app', labelKey: 'openSourcePage.toc.app' },
    ],
  },
];

function tocIds(items: TocItem[]): string[] {
  return items.flatMap((item) => [item.id, ...(item.children ? tocIds(item.children) : [])]);
}

const SECTION_IDS = tocIds(TOC);

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-xl bg-[#F5FBF7] px-4 py-3 font-mono text-[13px] leading-relaxed text-text-main">
      <code>{children}</code>
    </pre>
  );
}

function Heading({
  id,
  as,
  children,
}: {
  id: string;
  as: 'h2' | 'h3';
  children: ReactNode;
}) {
  const className =
    as === 'h2'
      ? 'scroll-mt-24 text-2xl font-semibold tracking-tight text-text-strong'
      : 'scroll-mt-24 mt-10 text-xl font-semibold text-text-strong';
  const Tag = as;
  return (
    <Tag id={id} className={className}>
      {children}
    </Tag>
  );
}

function TocList({
  items,
  depth,
  activeId,
  onPick,
}: {
  items: TocItem[];
  depth: number;
  activeId: string;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className={depth === 0 ? 'mt-3 flex flex-col gap-2' : 'mt-1.5 flex flex-col gap-1.5 border-l border-border-subtle pl-3'}>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              onClick={() => onPick(item.id)}
              className={`block text-[13px] leading-snug hover:text-primary-strong ${
                active ? 'font-semibold text-primary-strong' : 'text-text-secondary'
              }`}
              aria-current={active ? 'location' : undefined}
            >
              {t(item.labelKey)}
            </a>
            {item.children && (
              <TocList items={item.children} depth={depth + 1} activeId={activeId} onPick={onPick} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function OpenSourceGuide() {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState(SECTION_IDS[0] ?? '');

  useEffect(() => {
    const update = () => {
      let current = SECTION_IDS[0] ?? '';
      for (const id of SECTION_IDS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 200) current = id;
      }
      setActiveId(current);
    };
    // Headings are only measurable after mount.
     
    update();
    document.addEventListener('scroll', update, { passive: true, capture: true });
    return () => document.removeEventListener('scroll', update, { capture: true });
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-white text-text-main">
      <Header />
      <main className="flex-1">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-8 sm:px-6 sm:py-10 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
          <aside className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
            <nav aria-label={t('openSourcePage.tocLabel')}>
              <div className="font-mono text-xs font-semibold uppercase tracking-widest text-primary-strong">
                {t('openSourcePage.tocLabel')}
              </div>
              <TocList items={TOC} depth={0} activeId={activeId} onPick={setActiveId} />
            </nav>
          </aside>

          <article className="min-w-0 max-w-3xl">
            <div className="font-mono text-xs font-semibold uppercase tracking-widest text-primary-strong">
              {t('nav.openSourceKicker')}
            </div>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text-strong sm:text-5xl">
              {t('openSourcePage.title')}
            </h1>
            <p className="mt-4 text-base leading-relaxed text-text-secondary">{t('openSourcePage.lead')}</p>

            <section className="mt-10">
              <Heading id="bat-dau-nhanh" as="h2">
                {t('openSourcePage.toc.quick')}
              </Heading>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">
                {t('openSourcePage.quickBody')}
              </p>

              <Heading id="chay-local" as="h3">
                {t('openSourcePage.toc.local')}
              </Heading>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">
                {t('openSourcePage.localIntro')}
              </p>

              <p className="mt-6 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.gitPullBody')}
              </p>
              <CodeBlock>{`git clone https://github.com/KysoQR/KysoQR.git
cd KysoQR
git pull`}</CodeBlock>

              <p className="mt-6 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.npmCiBody')}
              </p>
              <CodeBlock>npm ci</CodeBlock>

              <p className="mt-6 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.envBody')}
              </p>
              <CodeBlock>{`cp .env.example .env`}</CodeBlock>
              <CodeBlock>{TRIAL_ENV}</CodeBlock>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.envNote')}
              </p>

              <p className="mt-6 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.runBody')}
              </p>
              <CodeBlock>npm run dev</CodeBlock>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                <a
                  href="http://localhost:3000/"
                  className="font-semibold text-primary-strong underline underline-offset-2"
                >
                  http://localhost:3000/
                </a>
              </p>

              <Heading id="deploy-pm2" as="h3">
                {t('openSourcePage.toc.pm2')}
              </Heading>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.pm2Body')}
              </p>
              <CodeBlock>{`npm ci
npm run build
npm install -g pm2
pm2 start npm --name kysoqr -- start
pm2 save
pm2 startup`}</CodeBlock>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.pm2Note')}
              </p>

              <Heading id="deploy-cloudflare" as="h3">
                {t('openSourcePage.toc.worker')}
              </Heading>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.workerBody')}
              </p>
              <CodeBlock>{`# ${t('openSourcePage.workerBuild')}
npm run cf:build

# ${t('openSourcePage.workerDeploy')}
npx wrangler versions upload`}</CodeBlock>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.workerEnv')}
              </p>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.workerLocal')}
              </p>
              <CodeBlock>npm run cf:preview</CodeBlock>
            </section>

            <section className="mt-12 border-t border-border-subtle pt-10">
              <Heading id="thuc-hien-ky" as="h2">
                {t('openSourcePage.toc.sign')}
              </Heading>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">
                {t('openSourcePage.signIntro')}
              </p>
              <ol className="mt-4 list-decimal space-y-3 pl-5 text-[15px] leading-relaxed text-text-secondary">
                <li>{t('openSourcePage.signSteps.download')}</li>
                <li>
                  {t('openSourcePage.signSteps.register')}{' '}
                  <a
                    href="https://cas.so/cas-id/chu-ky-so/"
                    className="font-semibold text-primary-strong underline underline-offset-2"
                  >
                    {`${t('openSourcePage.signSteps.registerLink')}.`}
                  </a>
                </li>
                <li>{t('openSourcePage.signSteps.do')}</li>
              </ol>
            </section>

            <section className="mt-12 border-t border-border-subtle pt-10">
              <Heading id="trien-khai-thuc-te" as="h2">
                {t('openSourcePage.toc.production')}
              </Heading>
              <p className="mt-3 text-base leading-relaxed text-text-secondary">
                {t('openSourcePage.productionIntro')}
              </p>

              <Heading id="dang-ky-vendor" as="h3">
                {t('openSourcePage.toc.vendor')}
              </Heading>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.vendorBody')}{' '}
                <a
                  href="https://cas.so/"
                  className="font-semibold text-primary-strong underline underline-offset-2"
                >
                  {`${t('openSourcePage.vendorLink')}.`}
                </a>
              </p>

              <Heading id="tao-app" as="h3">
                {t('openSourcePage.toc.app')}
              </Heading>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.appBody')}
              </p>
              <CodeBlock>{OWN_ENV}</CodeBlock>
              <p className="mt-3 text-[15px] leading-relaxed text-text-secondary">
                {t('openSourcePage.appWorker')}
              </p>
            </section>
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
