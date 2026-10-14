# Handoff Prompt — UI/UX Design Agent

You are designing the web product experience for **Communication**, an open-source operating environment for AI-assisted software engineering teams. Read `README.md`, `00-product-vision.md`, `01-domain-model.md`, `03-pipeline-engine.md`, `06-collaboration-identity.md`, `08-assistant.md`, `09-api-events-data.md`, and especially `10-ui-design-handoff.md` in this package. Do NOT treat these notes as proof that any API already exists; they are the intended functional contract.

Your job: produce a deeply considered and cohesive product UX, page map, flows, responsive wireframes and interaction specifications. Separate your UX output from backend design; do not redesign the scheduler, ACP/agent state or security. No need to ask for visual branding preferences to begin; choose neutral, professional defaults and explicitly show alternatives where appropriate.

Required focal screens: project overview across many repos and pipelines, attention/inbox view, collaborative ACP conversation with take-control/return-control, pipeline library/starter gallery, graph editor, immutable revision/assignment rollout and diff, expanded run execution tree/timeline, artifacts/HTML preview, setup and operational health, context-aware Communication assistant with navigation/highlighting and phrase-choice elicitation.

Must demonstrate these interactions:

1. A consultant opens five client projects and understands what requires action.
2. An agent runs within a project workspace containing frontend/backend repositories; human watches tool calls and takes control safely.
3. Someone clones a curated pipeline template and customizes APM profile, prompts, check loop, human gate, and publication.
4. A definition with six nodes fans out into 25 execution branches; user can inspect history without drawing a 150-node maze.
5. Assistant executes permitted structured app actions in a visible way, asks open-ended questions using meaningful phrase buttons, and shows before/after draft diffs before publication.
6. New version promotes only to selected Project; running attempts stay pinned to the old revision.
7. Sandbox incompatible / worker interrupted / missing credential / denied permissions have understandable recovery UI.

Deliver: information architecture, personas/jobs-to-be-done, annotated flows, state tables per view, high- and low-fidelity designs, accessible component system, animation reduced-motion path, implementation-ready frontend-backend event dependency matrix, and unresolved UX-specific choices. Include interaction/risk rationale and pass/fail acceptance criteria.
