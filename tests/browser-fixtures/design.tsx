import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import EditorWorkspace from "@/components/editor/EditorWorkspace";
import SubmissionList from "@/components/submissions/SubmissionList";
import {
    elementSeeds,
    pageSeeds,
    SEED_RECIPES,
} from "../../prisma/seed-recipes";
import {
    createEmptyEditorScene,
    editorElementSchema,
    type EditorScene,
    editorSceneSchema,
} from "@/lib/editor/schema";
import { resolveSceneDesign } from "@/lib/editor/design";
import { layoutDesignText } from "@/lib/editor/design-text-layout";
import { DEFAULT_RESOLVED_CONFIG } from "@/lib/pricing/constants";
import "@/app/globals.css";

const params = new URLSearchParams(location.search);
const pdfCase = params.get("pdfCase");
// bootCase mounts the editor without a submissionId so the boot path creates
// drafts through the mocked POST /api/submissions, exercising pointer and
// intent ownership without a database.
const bootCase = params.has("bootCase");
const recipe = SEED_RECIPES[0];
const elements = elementSeeds(recipe).map((row) => ({
    ...row,
    element: editorElementSchema.parse(JSON.parse(row.elementJson)),
}));
const fixtureKey = "guided-design-fixture";
const initial = {
    id: "fixture",
    userId: "fixture-user",
    revision: 0,
    title: "The Lantern and the Sea",
    status: "DRAFT",
    mode: "EDITOR",
    isTemplate: false,
    templateId: "fixture-template" as string | null,
    templateVersion: 1 as number | null,
    pages: pageSeeds(recipe).map((row) => {
        const templateTextOverrides = Object.fromEntries(
            elements.filter((element) =>
                element.pageLabel === row.pageLabel &&
                element.element.type === "text" && !element.element.locked
            ).map((row) => [
                row.element.id,
                row.pageLabel === "FRONT_COVER"
                    ? "The Lantern and the Sea"
                    : "Émilie watched the lantern dance upon the waves. Beyond the quiet harbor, a small boat waited for the tide.\n\nShe opened her notebook and began a new story.",
            ]),
        );
        return {
            ...row,
            revision: 0,
            sceneJson: JSON.stringify({
                ...JSON.parse(row.sceneJson),
                templateTextOverrides,
            }),
        };
    }),
};
const stored = sessionStorage.getItem(fixtureKey);
const book: typeof initial = stored ? JSON.parse(stored) : initial;
// Drafts issued by the mocked create endpoint; kept in memory only.
const createdBooks = new Map<string, typeof initial>();
function createBook(n: number): typeof initial {
    return {
        id: `created-${n}`,
        userId: "fixture-user",
        revision: 0,
        title: "",
        status: "DRAFT",
        mode: "EDITOR",
        isTemplate: false,
        templateId: null,
        templateVersion: null,
        pages: pageSeeds(recipe).map((row) => ({
            ...row,
            revision: 0,
            sceneJson: JSON.stringify(createEmptyEditorScene()),
        })),
    };
}
let currentSubmissionId: string | undefined = bootCase ? undefined : "fixture";
const controls = {
    failPage: "",
    failFonts: params.has("failFonts"),
    // Boot-path knobs: delay the create POST, 404 the created draft loads,
    // count create requests, and record every accepted server save.
    createDelay: Number(params.get("createDelay") ?? 0),
    failLoad: params.has("failLoad"),
    createCount: 0,
    saves: [] as Array<{ part: string; value: string; revision: number }>,
    setSubmissionId: (id: string | undefined) => {
        currentSubmissionId = id;
        render();
    },
    book,
    layouts: () =>
        book.pages.map((page) => {
            const scene = resolveSceneDesign(
                editorSceneSchema.parse(JSON.parse(page.sceneJson)),
                elements.filter((row) => row.pageLabel === page.pageLabel).map(
                    (row) => row.element,
                ),
            );
            return {
                pageLabel: page.pageLabel,
                scene,
                layouts: scene.elements.filter((element) =>
                    element.type === "text" && element.typographyVersion
                ).map((element) =>
                    element.type === "text"
                        ? { id: element.id, layout: layoutDesignText(element) }
                        : null
                ),
            };
        }),
};
declare global {
    interface Window {
        designFixture: typeof controls;
    }
}
Object.assign(window, { designFixture: controls });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
    const url = new URL(
        typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url,
        location.href,
    );
    if (url.origin !== location.origin) {
        throw new Error("External network blocked by fixture");
    }
    if (url.pathname.startsWith("/fonts/") && controls.failFonts) {
        return new Response("", { status: 503 });
    }
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const json = (value: unknown, status = 200) =>
        Response.json(value, { status });
    if (pdfCase && url.pathname === "/api/submissions") {
        return json({
            submissions: [{
                id: `download-fixture-${pdfCase}`,
                title: "Controlled PDF download",
                mode: "EDITOR",
                status: "APPROVED",
                pdfS3Key: "fixture-only",
                readingPdfS3Key: pdfCase === "legacy"
                    ? null
                    : "fixture-reading",
                rejectionReason: null,
                createdAt: "2026-01-01T00:00:00Z",
            }],
        });
    }
    if (!pdfCase && url.pathname === "/api/submissions" && init?.method === "POST") {
        controls.createCount++;
        if (controls.createDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, controls.createDelay));
        }
        const created = createBook(controls.createCount);
        createdBooks.set(created.id, created);
        return json({ submission: created });
    }
    const createdMatch = url.pathname.match(
        /^\/api\/submissions\/(created-\d+)(?:\/pages\/(.+))?$/,
    );
    if (createdMatch) {
        const created = createdBooks.get(createdMatch[1]);
        if (!created) return json({ error: "Unknown draft" }, 404);
        if (createdMatch[2]) {
            if (init?.method !== "PUT") return json({ error: "Unsupported method" }, 405);
            const page = created.pages.find((page) => page.pageLabel === createdMatch[2]);
            if (!page) return json({ error: "Unknown page" }, 404);
            const body = JSON.parse(String(init.body)) as {
                scene: EditorScene;
                revision: number;
            };
            if (body.revision !== page.revision) {
                return json({ error: "Stale revision" }, 409);
            }
            page.sceneJson = JSON.stringify(body.scene);
            page.revision++;
            controls.saves.push({ part: page.pageLabel, value: page.sceneJson, revision: page.revision });
            return json({ page });
        }
        if (init?.method === "PATCH") {
            const body = JSON.parse(String(init.body)) as { title: string; revision: number };
            if (body.revision !== created.revision) {
                return json({ error: "Stale title revision" }, 409);
            }
            created.title = body.title;
            created.revision++;
            controls.saves.push({ part: "title", value: created.title, revision: created.revision });
        } else if (controls.failLoad) {
            return json({ error: "Draft not found" }, 404);
        }
        return json({ submission: created });
    }
    // Native PDF links are served by the controlled HTTP fixture, not this fetch mock.
    if (url.pathname === "/api/assets") return json({ assets: [] });
    if (url.pathname.includes("/api/pricing")) {
        return json({
            ...DEFAULT_RESOLVED_CONFIG,
            pricingConfigVersion: DEFAULT_RESOLVED_CONFIG.version,
        });
    }
    if (url.pathname === "/api/templates/fixture-template/elements") {
        return json({ templateElements: elements, templateAssets: [] });
    }
    const match = url.pathname.match(
        /^\/api\/submissions\/fixture\/pages\/(.+)$/,
    );
    if (match && init?.method === "PUT") {
        const page = book.pages.find((page) => page.pageLabel === match[1]);
        if (!page) return json({ error: "Unknown page" }, 404);
        if (controls.failPage === page.pageLabel) {
            return json({ error: "Injected page save failure" }, 503);
        }
        const body = JSON.parse(String(init.body)) as {
            scene: EditorScene;
            revision: number;
        };
        if (body.revision !== page.revision) {
            return json({ error: "Stale revision" }, 409);
        }
        try {
            resolveSceneDesign(
                editorSceneSchema.parse(body.scene),
                elements.filter((row) => row.pageLabel === page.pageLabel).map(
                    (row) => row.element,
                ),
            );
        } catch (error) {
            return json({ error: String(error) }, 400);
        }
        page.sceneJson = JSON.stringify(body.scene);
        page.revision++;
        controls.saves.push({ part: page.pageLabel, value: page.sceneJson, revision: page.revision });
        sessionStorage.setItem(fixtureKey, JSON.stringify(book));
        return json({ page });
    }
    if (url.pathname === "/api/submissions/fixture") {
        if (init?.method === "PATCH") {
            const body = JSON.parse(String(init.body));
            if (body.revision !== book.revision) {
                return json({ error: "Stale title revision" }, 409);
            }
            book.title = body.title;
            book.revision++;
            controls.saves.push({ part: "title", value: book.title, revision: book.revision });
            sessionStorage.setItem(fixtureKey, JSON.stringify(book));
        }
        return json({ submission: book });
    }
    return json({ error: "Not available in isolated fixture" }, 503);
};
const root = createRoot(document.getElementById("root")!);
function render() {
    root.render(
        <>
            <div className="border-b bg-amber-50 px-6 py-2 text-xs">
                LOCAL FIXTURE · No database, accounts, or external services
            </div>
            {pdfCase
                ? (
                    <div className="p-6">
                        <SubmissionList />
                    </div>
                )
                : <EditorWorkspace submissionId={currentSubmissionId} />}
            <Toaster />
        </>,
    );
}
render();
