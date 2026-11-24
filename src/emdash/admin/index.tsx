/** @jsxImportSource react */
/**
 * The plugin's one admin page (plan Task U2, decisions 9, 14 and 17): the index table with Rebuild now, and the
 * settings that need no rebuild. It runs inside EmDash's admin, which provides React, kumo and phosphor (they stay
 * external in the build, scripts/build.mjs). The data layer is `api.ts`.
 */
import { Badge, Banner, Button, Empty, Input, Loader, Select, Switch, Table, Tooltip, TooltipProvider } from "@cloudflare/kumo";
import { ArrowClockwise, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { apiFetch } from "emdash/plugin-utils";
import * as React from "react";
import { AdminApiError, createAdminApi, detailsStale, mergeSaved, watchStatus, type AdminApi, type AdminStatus, type IndexesItem, type SearchSettings, type StatusWatch } from "./api.ts";
import { specOf } from "./keys.ts";
import { isApple } from "../../dom/shortcut.ts";

/** At this many pages the site is past the size this engine is made for (`SWITCH_ENGINE_AT` in core/build.ts). */
const SWITCH_ENGINE_AT = 5000;
const PLAN_LIMIT = "Your Cloudflare plan is too small for a search rebuild. The plugin needs the Workers Paid plan.";

const busy = (s: AdminStatus | null) => s?.state === "queued" || s?.state === "running";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The failed build's notice text, by error code. */
function failText(s: AdminStatus): string {
	if (s.errorCode === "plan-limit") return PLAN_LIMIT;
	if (s.errorCode === "no-collections") return "No collection is set up for search. Add search support to a collection, then rebuild.";
	return s.error || "The last build failed.";
}

const ago = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
function timeAgo(ms: number, now: number): string {
	const s = Math.round((ms - now) / 1000);
	if (s > -45) return "just now";
	for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
		if (Math.abs(s) >= size) return ago.format(Math.round(s / size), unit);
	}
	return "just now";
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function IndexSection({ api }: { api: AdminApi }) {
	const [item, setItem] = React.useState<IndexesItem | null>(null);
	const [loadError, setLoadError] = React.useState<string | null>(null);
	const [status, setStatus] = React.useState<AdminStatus | null>(null);
	const [couldNotCheck, setCouldNotCheck] = React.useState(false);
	const [asking, setAsking] = React.useState(false);
	const [notice, setNotice] = React.useState<{ variant: "default" | "error"; text: string } | null>(null);
	const [now, setNow] = React.useState(() => Date.now());
	const watch = React.useRef<StatusWatch | null>(null);
	/** The last status seen, the details shown, the latest index read, and whether the page is still mounted. */
	const last = React.useRef<AdminStatus | null>(null);
	const shown = React.useRef<IndexesItem | null | undefined>(undefined);
	const seq = React.useRef(0);
	const alive = React.useRef(true);

	const loadIndexes = React.useCallback(async () => {
		const mine = ++seq.current;
		try {
			const list = await api.indexes();
			// A newer read (or unmount) overtook this one: its answer may predate a publish.
			if (mine !== seq.current || !alive.current) return;
			shown.current = list[0] ?? null;
			setItem(shown.current);
			setLoadError(null);
		} catch (e) {
			if (mine === seq.current && alive.current) setLoadError(message(e));
		}
	}, [api]);

	const startWatch = React.useCallback(
		(initial?: AdminStatus) => {
			watch.current?.stop();
			watch.current = watchStatus(
				api,
				(u) => {
					setCouldNotCheck(u.couldNotCheck);
					if (!u.status) return;
					setStatus(u.status);
					// A build just ended, or the first status disagrees with the details shown: read them again.
					if (detailsStale(last.current, u.status, shown.current)) void loadIndexes();
					last.current = u.status;
				},
				initial ? { initial } : {},
			);
		},
		[api, loadIndexes],
	);

	React.useEffect(() => {
		alive.current = true;
		void loadIndexes();
		startWatch();
		const tick = setInterval(() => setNow(Date.now()), 30_000);
		return () => {
			alive.current = false;
			watch.current?.stop();
			clearInterval(tick);
		};
	}, [loadIndexes, startWatch]);

	async function rebuild() {
		setAsking(true);
		setNotice(null);
		try {
			const r = await api.rebuild();
			if (!alive.current) return;
			if (!r.started && r.code === "running") setNotice({ variant: "default", text: "A build is already running. Your rebuild starts when it ends." });
			else if (!r.started) setNotice({ variant: "error", text: r.code === "no-collections" ? failText({ ...r.status, errorCode: "no-collections" }) : `The rebuild did not start (${r.code ?? "unknown"}).` });
			// The build ends after this: the next idle status reads the details again.
			last.current = { state: "queued", pending: false };
			startWatch(r.status);
		} catch (e) {
			if (alive.current) setNotice({ variant: "error", text: `The rebuild did not start: ${message(e)}` });
		} finally {
			if (alive.current) setAsking(false);
		}
	}

	const building = busy(status);
	const active = item?.active ?? null;
	const rebuildButton = (label: string, variant: "primary" | "secondary") => (
		<Button variant={variant} size="sm" icon={<ArrowClockwise />} loading={asking} disabled={building} onClick={() => void rebuild()}>
			{label}
		</Button>
	);

	let body: React.ReactNode;
	if (loadError && !item) {
		body = (
			<Banner
				variant="error"
				icon={<WarningCircle weight="fill" />}
				title="Could not load the search index"
				description={loadError}
				action={
					<Button size="sm" onClick={() => void loadIndexes()}>
						Try again
					</Button>
				}
			/>
		);
	} else if (!item) {
		body = <Loader size="base" />;
	} else if (!active && !building) {
		body = (
			<Empty
				icon={<MagnifyingGlass size={40} />}
				title="Not built yet"
				description="Build the index so visitors can search the site."
				contents={rebuildButton("Build now", "primary")}
			/>
		);
	} else {
		const kb = active ? active.gzBytes / 1024 : 0;
		const share = kb / item.budgetKB;
		const color = share > 1 ? "error" : share > 0.8 ? "warning" : "success";
		body = (
			<div className="overflow-x-auto rounded-lg border border-kumo-line">
				<Table>
					<Table.Header>
						<Table.Row>
							<Table.Head>Name</Table.Head>
							<Table.Head>Size</Table.Head>
							<Table.Head>Content</Table.Head>
							<Table.Head>Last built</Table.Head>
							<Table.Head>
								<span className="sr-only">Actions</span>
							</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						<Table.Row data-index={item.name}>
							<Table.Cell>Site search</Table.Cell>
							<Table.Cell>
								{active ? (
									<Tooltip content={`Budget: ${item.budgetKB} KB gzip`}>
										<Badge variant={color}>{kb.toFixed(1)} KB</Badge>
									</Tooltip>
								) : (
									"–"
								)}
							</Table.Cell>
							<Table.Cell>{active ? `${plural(active.pages, "page")}, ${plural(active.sections, "section")}` : "Not built yet"}</Table.Cell>
							<Table.Cell data-cell="built">
								{building ? (
									<span className="flex items-center gap-2">
										<Loader size="sm" /> Building
									</span>
								) : active ? (
									<time dateTime={new Date(active.builtAt).toISOString()} title={new Date(active.builtAt).toLocaleString("en-US")}>
										{timeAgo(active.builtAt, now)}
									</time>
								) : (
									"Never"
								)}
							</Table.Cell>
							<Table.Cell>{rebuildButton("Rebuild now", "secondary")}</Table.Cell>
						</Table.Row>
					</Table.Body>
				</Table>
				{active?.siteUrl && (
					<p className="border-t border-kumo-line px-3 py-2 text-sm text-kumo-subtle" data-site-url="">
						Built for {active.siteUrl}, the site URL in EmDash's settings.
					</p>
				)}
			</div>
		);
	}

	return (
		<section className="space-y-3" aria-labelledby="search-index-title">
			<h2 id="search-index-title" className="text-lg font-semibold">
				Index
			</h2>
			{status?.state === "failed" && <Banner variant="error" icon={<WarningCircle weight="fill" />} title="The last build failed" description={failText(status)} />}
			{couldNotCheck && <Banner variant="alert" text="Could not check the build. Trying again every 30 seconds." />}
			{notice && <Banner variant={notice.variant} text={notice.text} />}
			{loadError && item && (
				<Banner
					variant="error"
					icon={<WarningCircle weight="fill" />}
					title="Could not refresh the search index"
					description={loadError}
					action={
						<Button size="sm" onClick={() => void loadIndexes()}>
							Try again
						</Button>
					}
				/>
			)}
			{active && active.pages >= SWITCH_ENGINE_AT && (
				<Banner variant="alert" text={`This site has more than ${SWITCH_ENGINE_AT.toLocaleString("en-US")} pages, past the size this search is made for. It gets slow to load.`} />
			)}
			{body}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function KeyField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
	return (
		<Input
			label={label}
			value={value}
			placeholder="Press a key"
			readOnly
			onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
				if (e.key === "Tab") return;
				e.preventDefault();
				if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey) return onChange("");
				const spec = specOf(e, isApple(navigator as Navigator & { userAgentData?: { platform?: string } }));
				if (spec) onChange(spec);
			}}
		/>
	);
}

const THEMES = { auto: "Auto (follow the visitor)", light: "Light", dark: "Dark" };

function SettingsSection({ api }: { api: AdminApi }) {
	const [draft, setDraft] = React.useState<SearchSettings | null>(null);
	const [loadError, setLoadError] = React.useState<string | null>(null);
	const [saving, setSaving] = React.useState(false);
	const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null);
	/** The draft as of now, for a save that resolves after more edits. */
	const latest = React.useRef(draft);
	latest.current = draft;

	const load = React.useCallback(() => {
		setLoadError(null);
		api.settings().then(setDraft, (e: unknown) => setLoadError(message(e)));
	}, [api]);
	React.useEffect(load, [load]);

	const set = (patch: Partial<SearchSettings>) => {
		setResult(null);
		setDraft((d) => (d ? { ...d, ...patch } : d));
	};

	async function save(e: React.FormEvent) {
		e.preventDefault();
		if (!draft) return;
		const sent = draft;
		setSaving(true);
		setResult(null);
		try {
			const saved = await api.saveSettings({ ...sent, keys: sent.keys.filter(Boolean) });
			// Edits made while saving stay, and stay unsaved.
			const m = mergeSaved(sent, latest.current ?? sent, saved);
			latest.current = m.draft;
			setDraft(m.draft);
			setResult(m.dirty ? { ok: false, text: "Saved, but later changes are not saved yet." } : { ok: true, text: "Saved." });
		} catch (err) {
			setResult({ ok: false, text: `Not saved: ${err instanceof AdminApiError ? err.message : message(err)}` });
		} finally {
			setSaving(false);
		}
	}

	let body: React.ReactNode;
	if (loadError) {
		body = (
			<Banner
				variant="error"
				icon={<WarningCircle weight="fill" />}
				title="Could not load the settings"
				description={loadError}
				action={
					<Button size="sm" onClick={load}>
						Try again
					</Button>
				}
			/>
		);
	} else if (!draft) {
		body = <Loader size="base" />;
	} else {
		const keyAt = (i: number) => draft.keys[i] ?? "";
		const setKey = (i: number, v: string) => {
			const keys = [keyAt(0), keyAt(1)];
			keys[i] = v;
			set({ keys });
		};
		body = (
			<form className="max-w-xl space-y-5" onSubmit={(e) => void save(e)}>
				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">Shortcut keys</legend>
					<p className="text-sm text-kumo-subtle">Click a field and press the keys. Backspace clears it. "mod" is Cmd on a Mac and Ctrl elsewhere.</p>
					<div className="grid gap-3 sm:grid-cols-2">
						<KeyField label="First shortcut" value={keyAt(0)} onChange={(v) => setKey(0, v)} />
						<KeyField label="Second shortcut" value={keyAt(1)} onChange={(v) => setKey(1, v)} />
					</div>
				</fieldset>
				<div className="space-y-3">
					<Switch label="Take over the theme's search form" checked={draft.takeover.enabled} onCheckedChange={(enabled: boolean) => set({ takeover: { ...draft.takeover, enabled } })} />
					<p className="text-sm text-kumo-subtle">When it is on, the theme's own search form opens the search dialog. Turn it on if the theme has a search form whose input is named below.</p>
					<p className="text-sm text-kumo-subtle">
						Does your theme work with takeover?{" "}
						<a href="https://astronomic.dev/docs/search/themes" target="_blank" rel="noopener" className="text-kumo-link underline underline-offset-2">
							Read how to check.
						</a>
					</p>
					<Input label="Search input name" value={draft.takeover.inputName} disabled={!draft.takeover.enabled} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ takeover: { ...draft.takeover, inputName: e.target.value } })} />
				</div>
				<div className="space-y-2">
					<Input label="Search box text" value={draft.placeholder} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ placeholder: e.target.value })} />
					<p className="text-sm text-kumo-subtle">Shows in the search popup. With takeover on, it also shows in your theme's search box.</p>
				</div>
				<Select label="Theme" value={draft.theme} items={THEMES} onValueChange={(v: unknown) => set({ theme: (v as SearchSettings["theme"]) ?? "auto" })} />
				<Input label="Results page URL" value={draft.results} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ results: e.target.value })} />
				<div className="space-y-2">
					<div className="flex items-center gap-3">
						<Button type="submit" variant="primary" loading={saving}>
							Save
						</Button>
						{result && (
							<span role="status" className={result.ok ? "text-sm text-kumo-subtle" : "text-sm text-kumo-danger"}>
								{result.text}
							</span>
						)}
					</div>
					<p className="text-sm text-kumo-subtle">Changes show on the next page view. No rebuild needed.</p>
				</div>
			</form>
		);
	}

	return (
		<section className="space-y-3" aria-labelledby="search-settings-title">
			<h2 id="search-settings-title" className="text-lg font-semibold">
				Settings
			</h2>
			{body}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SearchPage() {
	const api = React.useMemo(() => createAdminApi(apiFetch), []);
	return (
		<TooltipProvider>
			<div className="max-w-4xl space-y-6">
				<header>
					<h1 className="text-2xl font-semibold">Search</h1>
					<p className="text-sm text-kumo-subtle">The site search index and how the search dialog looks and opens.</p>
				</header>
				<IndexSection api={api} />
				<SettingsSection api={api} />
			</div>
		</TooltipProvider>
	);
}

export const pages = { "/settings": SearchPage };
