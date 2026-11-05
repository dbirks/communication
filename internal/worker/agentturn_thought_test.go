package worker

// Offline (no-ACP) pins for ADR-0076: the one fallback that reads an outputs
// document out of the turn's final THOUGHT text when the reply channel said
// nothing the agent said.
//
// Actions run 42094770050, issue #351, github-loop /implement attempt 1
// (evidence ~/.cache/pi-orch/communication/evidence/r42094770050/gh-loop.out):
// the agent did the whole job — tests green, draft PR #352 opened — and then
//
//	E359 conversation.message.agent  "\n\n"             (the only reply text)
//	E365 conversation.thought        "Changes made …:\n\n```json\n{\"summary\": \"The tally project …
//	                                                    \"files_changed\": [...]}\n```"
//	E366 agent.session.disconnected  reason=process_exited
//	E370 node.attempt.failed         error_class=invalid_output
//
// detail `agent turn produced no text to extract structured outputs from
// (01 invariant 4 …)`. A reasoning model routed through pi had answered on the
// thought channel; the worker only ever judged the message channel, and
// invalid_output is permanent for that node, so the run died after the work was
// done. These rows pin the narrow rescue and, more importantly, everything it
// must NOT touch: a substantive reply is never overruled by its own reasoning,
// a document that fails the schema still dies invalid_output with the reply's
// own evidence, a node that declares no schema is unverifiable and stays
// untouched, and a silence left by a dead or retrying harness is still the
// transport's story (agentturn_silence.go) told before any thought is read.
//
// usage: go test ./internal/worker/ -run TestAgentTurnOutputsFromThought

import (
	"context"
	"strings"
	"testing"

	"github.com/dbirks/communication/internal/domain"
	"github.com/dbirks/communication/internal/events"
)

// thoughtFence replays E365's shape: the answer prose, then the envelope in a
// fenced json block — the same form selectOutputDocument accepts in a reply,
// applied to the reasoning channel.
const thoughtFence = "Changes made (the repo lives in the worktree at ./tally):\n\n" +
	"```json\n{\n  \"summary\": \"The tally project already existed; added the missing total test and updated the README.\",\n" +
	"  \"files_changed\": [\"app/tally.js\", \"README.md\"]\n}\n```"

// sendThought streams one agent_thought_chunk: pi's reasoning channel
// (docs/compatibility/ACP.md's pi row — it streams agent_thought_chunk
// alongside agent_message_chunk, and 04 § 4 says the client decides what each
// one means).
func sendThought(s *agentSessionStub, text string) {
	s.eventsCh <- domain.ConversationEvent{Kind: "thought_chunk", Text: text}
}

// runThoughtShape drives one turn: `stream` scripts the session's event order,
// `schema` is the node's declared outputs (nil = the node declares none), and
// peerGone answers the harness's transport state exactly as the silence tests
// do. The whole turn is the executor's own code path, so what a test asserts is
// what the attempt row would carry.
func runThoughtShape(t *testing.T, schema any, peerGone bool,
	stream func(s *agentSessionStub)) (AttemptResult, *agentTurnFixture) {
	t.Helper()
	f := newAgentTurnFixture(t, domain.EnforceDisabled)
	sess := newAgentSessionStub(domain.SessionInfo{})
	sess.peerGone = peerGone
	sess.stderr = "(node:469) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental"
	sess.promptFn = func(_ context.Context, s *agentSessionStub, _ string) (domain.StopReason, error) {
		stream(s)
		return domain.StopEndTurn, nil
	}
	f.spawn.queue(sess)
	c := f.claim(agentCfg("implement the plan"))
	if schema != nil {
		// A nil map in an `any` field is a NON-nil interface: the claim must
		// carry true absence when the node declares no outputs at all.
		c.OutputsSchema = schema
	}
	res, err := f.turn.Execute(context.Background(), c, f.sink)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	return res, f
}

// noticeKinds lists the kinds of every conversation.notice row the attempt
// journalled — the transcript's own record of what the executor decided to say.
func noticeKinds(f *agentTurnFixture) []string {
	var out []string
	for _, ev := range f.sink.events {
		if ev.Type != events.TypeConversationNotice {
			continue
		}
		if p, ok := ev.Payload.(events.NoticePayload); ok {
			out = append(out, p.Kind)
		}
	}
	return out
}

// hasNoticeKind reports whether the attempt journalled a notice of `kind`.
func hasNoticeKind(f *agentTurnFixture, kind string) bool {
	for _, k := range noticeKinds(f) {
		if k == kind {
			return true
		}
	}
	return false
}

// TestAgentTurnOutputsFromThought is the incident and its boundaries.
func TestAgentTurnOutputsFromThought(t *testing.T) {
	// The rescue itself: the blank reply of E359 plus E365's final thought.
	t.Run("blank reply + validating thought document succeeds with a notice", func(t *testing.T) {
		res, f := runThoughtShape(t, implementSchema(), false, func(s *agentSessionStub) {
			s.sendChunk("\n\n")
			sendThought(s, thoughtFence)
		})
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded — the agent answered, on the other channel", res)
		}
		obj, ok := res.Outputs.(map[string]any)
		if !ok {
			t.Fatalf("outputs = %#v, want the thought's JSON object", res.Outputs)
		}
		summary, _ := obj["summary"].(string)
		if summary == "" {
			t.Fatalf("outputs %v: the thought envelope's summary is missing", obj)
		}
		if _, has := obj["files_changed"]; !has {
			t.Fatalf("outputs %v: the thought envelope's files_changed is missing", obj)
		}
		if res.Outcome != "passed" || res.OutputsDigest == "" {
			t.Fatalf("res = %+v, want a normal succeeded envelope (digest, outcome) — the source channel changes nothing downstream", res)
		}
		if !hasNoticeKind(f, noticeKindOutputsFromThought) {
			t.Fatalf("notice kinds = %v, want a %s row: an envelope from the reasoning channel must say which channel supplied it",
				noticeKinds(f), noticeKindOutputsFromThought)
		}
		if hasNoticeKind(f, noticeKindOutputsMerged) {
			t.Fatalf("notice kinds = %v, want no merge row — one object answered whole", noticeKinds(f))
		}
		// The rescue is not the agent's words: the message rows stay what the
		// reply channel streamed (ADR-0072 § 7 quotes them as the answer, and
		// ADR-0076 § Consequences keeps them honest).
		for _, ev := range f.sink.events {
			if p, ok := ev.Payload.(events.MessageAgentPayload); ok {
				if strings.Contains(p.Text, "summary") || strings.TrimSpace(p.Text) != "" {
					t.Fatalf("agent message row %q must stay the reply channel's (empty) text, never the rescued envelope", p.Text)
				}
			}
		}
	})

	// Thoughts arrive as many chunks; the buffer coalesces them like message
	// chunks, so an envelope split across chunks is still one document.
	t.Run("thought chunks coalesce the same way message chunks do", func(t *testing.T) {
		res, f := runThoughtShape(t, implementSchema(), false, func(s *agentSessionStub) {
			s.sendChunk("\n\n")
			sendThought(s, "Changes made:\n\n```json\n{\"sum")
			sendThought(s, "mary\": \"Added the total test.\",\n  \"files_changed\": [\"app/tally.js\"]}\n```")
		})
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded — the thought chunks are one stream", res)
		}
		if !hasNoticeKind(f, noticeKindOutputsFromThought) {
			t.Fatalf("notice kinds = %v, want the channel note", noticeKinds(f))
		}
	})

	// "LAST thought text" means since the last tool window: reasoning that
	// streamed BEFORE the final tool call is stale, not the answer.
	t.Run("only the thoughts after the last tool call are candidates", func(t *testing.T) {
		res, _ := runThoughtShape(t, implementSchema(), false, func(s *agentSessionStub) {
			sendThought(s, `{"summary": "stale draft from before the work", "files_changed": ["wrong/path"]}`)
			s.sendToolCall()
			s.sendChunk("\n\n")
			sendThought(s, thoughtFence)
		})
		if res.Status != AttemptStatusSucceeded {
			t.Fatalf("res = %+v, want succeeded on the FINAL thought's document", res)
		}
		obj := res.Outputs.(map[string]any)
		if s, _ := obj["summary"].(string); s == "stale draft from before the work" {
			t.Fatal("the rescue took a thought from before the last tool call — that is not the final answer")
		}
	})

	// The schema still judges. A thought that names only half the envelope is
	// not accepted, and the attempt dies with the REPLY's evidence, unchanged.
	t.Run("blank reply + thought that fails the schema is invalid_output as today", func(t *testing.T) {
		res, f := runThoughtShape(t, implementSchema(), false, func(s *agentSessionStub) {
			s.sendChunk("\n\n")
			sendThought(s, "```json\n{\"summary\": \"only half the declared envelope\"}\n```")
		})
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want failed/invalid_output — the fallback may rescue, it may not invent a pass", res)
		}
		if hasNoticeKind(f, noticeKindOutputsFromThought) {
			t.Fatalf("notice kinds = %v, want no rescue notice on a failed attempt", noticeKinds(f))
		}
	})

	// A node that declares no outputs schema cannot be verified, so the arm
	// never runs there: schema-blind extraction stays exactly today's.
	t.Run("no declared outputs schema means no thought fallback", func(t *testing.T) {
		res, f := runThoughtShape(t, nil, false, func(s *agentSessionStub) {
			s.sendChunk("")
			sendThought(s, thoughtFence)
		})
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want today's failed/invalid_output — nothing verified that thought", res)
		}
		if hasNoticeKind(f, noticeKindOutputsFromThought) {
			t.Fatalf("notice kinds = %v, want none", noticeKinds(f))
		}
	})

	// The agent spoke: its answer owns the attempt even when its reasoning also
	// holds a valid envelope. The thought channel is never consulted.
	t.Run("a substantive reply is never overruled by its own thoughts", func(t *testing.T) {
		res, f := runThoughtShape(t, implementSchema(), false, func(s *agentSessionStub) {
			s.sendChunk("Implemented the change and opened the draft PR; the summary is in the PR body.")
			sendThought(s, thoughtFence)
		})
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want today's failed/invalid_output for a prose reply", res)
		}
		if hasNoticeKind(f, noticeKindOutputsFromThought) {
			t.Fatalf("notice kinds = %v, want none — a reply with substance never consults thoughts", noticeKinds(f))
		}
	})

	// Ordering pin: banner-only over an EXITED harness is the silence
	// agentturn_silence.go already calls infra, and it stays infra even though
	// a perfectly good envelope sits in the thoughts. An agent that never got
	// to answer has no answer to rescue; the transport's story is told first.
	t.Run("banner-only + dead harness is infra even with a valid thought", func(t *testing.T) {
		res, f := runThoughtShape(t, implementSchema(), true, func(s *agentSessionStub) {
			s.sendChunk(piBannerChunk)
			sendThought(s, thoughtFence)
		})
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra — the silence classifier runs before the thought fallback", res)
		}
		if hasNoticeKind(f, noticeKindOutputsFromThought) {
			t.Fatalf("notice kinds = %v, want none: the fallback must not speak for a harness that never answered", noticeKinds(f))
		}
	})

	// And the untouched original: banner-only, exited, no thoughts at all.
	t.Run("banner-only + dead harness + no thoughts is infra unchanged", func(t *testing.T) {
		res, f := runThoughtShape(t, implementSchema(), true, func(s *agentSessionStub) {
			s.sendChunk(piBannerChunk)
		})
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInfra {
			t.Fatalf("res = %+v, want failed/infra as agentturn_silence_test.go pins", res)
		}
		if len(noticeKinds(f)) != 0 {
			t.Fatalf("notice kinds = %v, want none", noticeKinds(f))
		}
	})

	// The rescue is held to the inline cap like any other envelope: a thought
	// document too large to travel inline fails the way a reply would, and is
	// never journalled as a success.
	t.Run("an oversized thought envelope is not accepted", func(t *testing.T) {
		big := `{"summary": "` + strings.Repeat("x", 40<<10) + `"}`
		res, f := runThoughtShape(t, implementSchema(), false, func(s *agentSessionStub) {
			s.sendChunk("\n\n")
			sendThought(s, "```json\n"+big+"\n```")
		})
		if res.Status != AttemptStatusFailed || res.ErrorClass != ErrorClassInvalidOutput {
			t.Fatalf("res = %+v, want failed/invalid_output — the 32 KiB inline cap does not stretch for the thought channel", res)
		}
		if hasNoticeKind(f, noticeKindOutputsFromThought) {
			t.Fatalf("notice kinds = %v, want none", noticeKinds(f))
		}
	})
}
