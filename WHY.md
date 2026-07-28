# Two Days of Nothing

*Why this exists. A personal account by the author.*

[中文版 / Chinese version](WHY.zh-CN.md) <!-- sanitize-scan:allow (the link label is intentionally in Chinese so Chinese readers find it) -->

---

I was writing research code with AI. Not shipping a product — doing research, where an idea changes
as you talk about it and a dead end means backing up and trying another way.

Using Codex, I installed superpowers, a popular development-workflow plugin. It started laying out
test scenarios, red lights and green lights, coverage. I went along with it for **two solid days of
intense conversation**.

Then I realised I had nothing.

It had not done a single step wrong. It had simply assumed, from beginning to end, that I was
shipping software. What I was actually doing was work where today's conclusion can be overturned
tomorrow — **there is no "passed" state to reach**.

That was the first time I really hit the boundary of these tools. Not that it was stupid. **It was
answering a different question, and I had spent two days assuming we were talking about the same
one.**

That was also when I noticed how far Codex had been pulled off course. I opened a Claude account,
looking for another head to think with. Only after finding one did I understand: the problem was not
the plugin itself — **it was that I had used it in a situation it was never meant for.** I turned it
off.

## A different model, a different wall

Claude did solve a batch of problems. But use it long enough and another wall appears: **once the
context gets long, and the scenario is a genuinely complicated research one, it starts going in
circles inside its own trap.**

So I went back to Codex for help. Back and forth like that, I finally saw the thing that actually
worried me:

**The pit is usually dug far upstream, and the model will happily patch downstream forever.**

It is extremely good at fixing the exact spot you point at. Say it breaks here, it fixes here. Say
that is wrong, it fixes that. Each patch is more elegant than the last. **What it almost never does
is look up and ask whether the original problem was defined wrong.**

I could not review patches as fast as it could produce them. And every one of them was built on a
foundation that might be crooked.

## So I stopped looking for a smarter model

Once that landed, my thinking changed.

And I quickly realised something more serious: **I already had the two best models in the world in
front of me. There is nothing above them.**

Which means "go find a smarter one" **is not an available move**. This is the ceiling. If the
improvement cannot come from *stronger*, it has to come from somewhere else —

**it has to come from *different*.**

**The problem was never that the model was not clever enough. It was that I only had one mind in the
room.**

Ask one model to check its own work and it agrees with itself. Show a reviewer the answer first and
it tends to nod. It looks like corroboration; it is the same line of thought sampled twice, and your
confidence has not moved.

So what I wanted was not "ask again". It was **two top models from different vendors, trained
differently, each reading the same raw material on its own, neither able to see the other's
conclusion — and then made to cross-examine each other.**

The word that carries the weight is *independent*, and it has to be enforced by **structure**, not by
request. Not "please be objective" — make it **physically unable** to see the other side's summary.
Round one, nobody sees anybody. Round two, the frozen conclusions go on the table and they have to
answer each other.

One more thing I only understood later, and it matters just as much: **failure has to make a noise.**
An empty reply, a truncated answer, a process killed halfway — those outputs look **exactly** like
"I looked and found nothing". A broken reviewer quietly emits an approval. So every way of failing
needs its own name, and none of them may turn into a pass.

The uses go well beyond review. **Throw a new idea at them for a hard adversarial round before you
start**, and you can rule out a lot of wrong directions in advance. That is far cheaper than
discovering the direction was wrong after you have finished.

Ever since those two wasted days, any external tool or workflow I am about to adopt gets reviewed
first, against my real task: **is there a pit in here? Keep what is good, throw out what is not.**

## I cannot read code, and that turns out to be the point

I am not a programmer. I cannot read that code.

Precisely because I cannot, I am in no position to judge by feel that a passage "looks fine". **All I
have is mechanism.**

So I let two different minds argue, and I take the conclusion — along with the evidence behind it
that I can go and check.

It is a bit like being the boss. **A boss does not need to know how you did it. The boss needs the
result, and needs to know whether it holds.** That is the point at which I finally felt like I was
driving: slumped in the chair, maybe, but with my hands on the wheel.

## What it costs, and a cheaper road

Honestly: **this is expensive.**

Building it consumed roughly **a month of Claude Max 20x**. Running it is expensive too — a full
panel means two models going several rounds. This version depends on **Claude Max 20x plus Codex Pro
5x**.

So I built a cheaper road as well: **a single sequential review**, one independent second opinion,
for small disagreements and for the times a single run did not settle the question. **Only things
that are genuinely costly to get wrong deserve the full panel.**

And one lesson I value more than the tool itself:

**If the panel finishes and still has not converged, do not immediately run it again. Go back and ask
whether the problem itself is the problem.**

Of the disagreements left over, how many are an unimportant long tail? It is the same principle as
before: **stop patching downstream; go back and look at the definition upstream.**

## What it cannot do

This part has to be said plainly, or the rest is just advertising.

- It **cannot** tell you whether a conclusion is true. It can tell you whether the conclusion was
  anchored to something checkable. If it was not, that goes to a human.
- **Both models agreeing does not make it right.** Agreement is a fact about the models, not about
  the world.
- A number in the evidence field does not make the evidence real.
- The judgements that matter still need a person to sign them.

## A seed

This version needs both a Claude and a Codex subscription to run. That is its barrier to entry, and I
admit it.

**I am only putting out a seed.** The same idea can be turned into a self-review inside a single
model — Codex reviewing Codex, or Claude reviewing Claude. Then one model could do basic
self-checking, at a far lower barrier. Windows and macOS I simply do not have the energy for; anyone
who does is welcome to take this and adapt it.

What I actually want to leave behind is not the code. It is the idea:

**Let AI review what AI produced. But with two different minds, made to cross-examine each other —
not one mind nodding at itself.**

**Agreement is not truth. Independence is.**
