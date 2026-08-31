# About ChatCloser

Most small and mid-sized service businesses lose leads the same way: a
customer messages on WhatsApp with a question, nobody's free to reply for
a few hours, and by the time someone does, the customer has already
booked with whoever answered first. Hiring someone to sit on WhatsApp
all day isn't realistic for a five-person plumbing company or a local
roofing crew — but losing every lead that arrives outside business hours
isn't realistic either.

ChatCloser is built to close that gap. It's an AI agent that answers a
business's WhatsApp in real time, using nothing but that business's own
knowledge base — hours, services, pricing, policies — so it never
improvises an answer it shouldn't. It asks the right follow-up questions,
captures a qualified lead the moment it has enough information, and when
a customer is ready to buy, it can generate a real payment link and close
the sale on the spot, at any hour, without anyone touching a keyboard.

What makes this different from a typical AI chatbot wrapper isn't the
conversation quality — it's what the AI is deliberately *not* trusted to
do. It can never invent a price: every number it quotes comes from a
price list the business controls, checked against real data before a
payment link is ever generated. And it's never the thing that confirms a
sale happened — that confirmation only ever comes from Stripe's own
verified payment webhook, sent as a fixed message the code writes, never
something the AI free-generates. In practice, that means a business gets
genuinely autonomous sales — nobody has to manually close a routine
deal — without taking on the liability of an AI that could hallucinate a
payment that never actually landed.

Everything else is built around making that safe automation easy to run
and easy to trust. The business brings its own AI provider key — Claude,
GPT, Gemini, DeepSeek, or a free-tier option like Groq or NVIDIA NIM — so
the AI spend is always theirs, never a hidden markup. An admin panel with
real accounts, owner/staff roles, and a full audit log makes it something
more than one person can safely run. Outbound webhooks let it plug into
whatever CRM or spreadsheet a business already uses. And because it's
built on WhatsApp — where the customer already is — there's no app to
download and no new habit to learn on either side of the conversation.

ChatCloser isn't trying to be a general-purpose messaging platform. It's
a focused tool for one specific, common problem: a service business that
wants every WhatsApp inquiry answered immediately, qualified properly,
and — when the customer's ready — closed, without needing to staff a
phone line around the clock to do it.

See `README.md` for the full feature list and setup instructions.
