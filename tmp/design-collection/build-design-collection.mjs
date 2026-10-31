import { execFileSync } from 'node:child_process';
// Builds the remediation design pages as one Demistify collection:
// the same Pages list in every page's ex-nav, readers embedded from live sources, one shared index.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const [demistifyCli, docsRoot] = process.argv.slice(2);

// Collection order; the first page is Home. `source` is the live authoring page, `reader` the delivered file.
// `inMenu` pages make up the Pages menu; the rest are reached from their set's own links and from search.
// A page with a `set` gets only its set's pages in its menu, under each page's `setLabel`, in the order below.
const collectionPages = [
	{
		label: 'Identity decisions',
		source: 'wip/2026-10-27-identity-owner-decisions/index.source.html',
		embeds: false,
		inMenu: true,
	},
	{
		label: 'Identity design',
		source: 'specs/2026-10-24-agent-identity/index.source.html',
		embeds: true,
		inMenu: true,
	},
	{
		label: 'Item two',
		source: 'specs/2026-10-30-item-two/index.source.html',
		embeds: false,
		inMenu: true,
		set: 'item-two',
		setLabel: 'Overview',
	},
	{
		label: 'Item two delivery plan',
		source: 'specs/2026-10-30-item-two/plans/2026-10-30-item-two-delivery.source.html',
		embeds: false,
		set: 'item-two',
		setLabel: 'Delivery plan',
	},
	{
		label: 'Identity delivery plan (D2–D7)',
		source: 'specs/2026-10-24-agent-identity/plans/2026-10-27-agent-identity-delivery.source.html',
		embeds: false,
		inMenu: true,
	},
	{
		label: 'Delivery orchestration',
		source: 'specs/2026-10-24-delivery-orchestration/index.source.html',
		embeds: true,
		inMenu: true,
	},
	{
		label: 'Switchboard remediation',
		source: 'specs/2026-10-24-tool-portal-remediation/index.source.html',
		embeds: true,
		inMenu: true,
	},
	{
		label: 'Switchboard remediation plan',
		source:
			'specs/2026-10-24-tool-portal-remediation/plans/2026-10-28-switchboard-remediation-delivery.source.html',
		embeds: false,
		inMenu: true,
	},
	{
		label: 'Switchboard decisions',
		source: 'wip/2026-10-24-remediation-owner-decisions/index.source.html',
		embeds: false,
		inMenu: true,
	},
	{
		label: 'People sign-in',
		source: 'specs/2026-10-20-people-sign-in/requirements.source.html',
		embeds: true,
		inMenu: true,
	},
	{
		label: 'Switchboard remediation: Requirements',
		source: 'specs/2026-10-24-tool-portal-remediation/requirements.source.html',
		embeds: true,
	},
	{
		label: 'Switchboard remediation: Specification',
		source: 'specs/2026-10-24-tool-portal-remediation/specification.source.html',
		embeds: true,
	},
	{
		label: 'Switchboard remediation: Program Design',
		source: 'specs/2026-10-24-tool-portal-remediation/program-design.source.html',
		embeds: false,
	},
	{
		label: 'Switchboard remediation: Verification Design',
		source: 'specs/2026-10-24-tool-portal-remediation/verification-design.source.html',
		embeds: true,
	},
	{
		label: 'Identity: Requirements',
		source: 'specs/2026-10-24-agent-identity/requirements.source.html',
		embeds: true,
	},
	{
		label: 'Identity: Specification',
		source: 'specs/2026-10-24-agent-identity/specification.source.html',
		embeds: true,
	},
	{
		label: 'Identity: Program Design',
		source: 'specs/2026-10-24-agent-identity/program-design.source.html',
		embeds: false,
	},
	{
		label: 'Identity: Verification Design',
		source: 'specs/2026-10-24-agent-identity/verification-design.source.html',
		embeds: true,
	},
	{
		label: 'Identity: Alternatives',
		source: 'specs/2026-10-24-agent-identity/alternatives.source.html',
		embeds: true,
	},
	{
		label: 'Orchestration: Requirements',
		source: 'specs/2026-10-24-delivery-orchestration/requirements.source.html',
		embeds: true,
	},
	{
		label: 'Orchestration: Specification',
		source: 'specs/2026-10-24-delivery-orchestration/specification.source.html',
		embeds: true,
	},
	{
		label: 'Orchestration: Program Design',
		source: 'specs/2026-10-24-delivery-orchestration/program-design.source.html',
		embeds: false,
	},
	{
		label: 'Orchestration: Verification Design',
		source: 'specs/2026-10-24-delivery-orchestration/verification-design.source.html',
		embeds: true,
	},
	{
		label: 'People sign-in: Specification',
		source: 'specs/2026-10-20-people-sign-in/2026-10-20-people-sign-in.source.html',
		embeds: true,
	},
	{
		label: 'People sign-in: Program Design',
		source: 'specs/2026-10-20-people-sign-in/program-design.source.html',
		embeds: false,
	},
	{
		label: 'People sign-in: Verification Design',
		source: 'specs/2026-10-20-people-sign-in/verification-design.source.html',
		embeds: true,
	},
	{
		label: 'Organization model (decided; now in the identity design)',
		source: 'wip/2026-10-26-organization-model/index.source.html',
		embeds: false,
	},
	{
		label: 'Tool Portal design (base, 10-14; now Switchboard)',
		source: 'specs/2026-10-14-portable-tool-portal-hosts/index.source.html',
		embeds: true,
	},
	{
		label: 'Fleet Framework: who owns what (10-18)',
		source: 'specs/2026-10-18-fleet-framework/who-owns-what.source.html',
		embeds: false,
	},
	{
		label: 'Item two: Requirements',
		set: 'item-two',
		setLabel: 'Requirements',
		source: 'specs/2026-10-30-item-two/requirements.source.html',
		embeds: false,
	},
	{
		label: 'Item two: Specification',
		set: 'item-two',
		setLabel: 'Specification',
		source: 'specs/2026-10-30-item-two/specification.source.html',
		embeds: false,
	},
	{
		label: 'Item two: Program Design',
		set: 'item-two',
		setLabel: 'Program Design',
		source: 'specs/2026-10-30-item-two/program-design.source.html',
		embeds: false,
	},
	{
		label: 'Item two: Verification Design',
		set: 'item-two',
		setLabel: 'Verification Design',
		source: 'specs/2026-10-30-item-two/verification-design.source.html',
		embeds: false,
	},
].map((page) => ({ ...page, reader: page.source.replace(/\.source\.html$/, '.html') }));

const itemTwoMenuOrder = ['Overview', 'Requirements', 'Specification', 'Program Design', 'Verification Design', 'Delivery plan'];

function menuTargetsFor(page) {
	if (!page.set) return collectionPages.filter((target) => target.inMenu).map((target) => ({ target, label: target.label }));
	return collectionPages
		.filter((target) => target.set === page.set)
		.sort((left, right) => itemTwoMenuOrder.indexOf(left.setLabel) - itemTwoMenuOrder.indexOf(right.setLabel))
		.map((target) => ({ target, label: target.setLabel }));
}

function pagesNavigationFor(page) {
	const fromDirectory = dirname(join(docsRoot, page.source));
	const links = menuTargetsFor(page)
		.map(
			({ target, label }) =>
				`<a href="${relative(fromDirectory, join(docsRoot, target.reader))}">${label}</a>`,
		)
		.join('\n');
	return `<ex-nav for="content"><nav slot="pages" aria-label="Pages">\n${links}\n</nav></ex-nav>`;
}

const exNavPattern = /<ex-nav for="content">[\s\S]*?<\/ex-nav>/;
for (const page of collectionPages) {
	const sourcePath = join(docsRoot, page.source);
	const html = readFileSync(sourcePath, 'utf8');
	const withNavigation = exNavPattern.test(html)
		? html.replace(exNavPattern, pagesNavigationFor(page))
		: html.replace('<ex-document', `${pagesNavigationFor(page)}\n<ex-document`);
	if (!withNavigation.includes('slot="pages"'))
		throw new Error(`${page.source}: no place for the Pages navigation`);
	writeFileSync(sourcePath, withNavigation);

	const readerPath = join(docsRoot, page.reader);
	if (page.embeds)
		execFileSync('node', [demistifyCli, 'embed', sourcePath, readerPath], { encoding: 'utf8' });
	else copyFileSync(sourcePath, readerPath); // an authored inline page joins the index without an embed
	console.log(`prepared ${page.reader}`);
}

const readerPaths = collectionPages.map((page) => join(docsRoot, page.reader));
console.log(
	execFileSync('node', [demistifyCli, 'index', ...readerPaths], { encoding: 'utf8' }).trim(),
);
console.log(
	execFileSync('node', [demistifyCli, 'check', ...readerPaths], { encoding: 'utf8' }).trim(),
);
