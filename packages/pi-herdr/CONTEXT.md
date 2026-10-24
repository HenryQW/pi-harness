# Pi Herdr

Pi Herdr is the shared boundary for Pi packages that use the Herdr command-line interface or Unix socket. It also shares process-local checkout admission through Pi's public event bus. Herdr owns command meanings; consumers own conversation workflows and response validation.

## Language

**Socket request**:
One bounded, identity-checked Herdr request. Once dispatched, an error does not prove that a mutation did not occur; the client never retries it.

**Checkout admission**:
The shared permission that excludes competing Pi writes while a direct worker or durable background writer owns a checkout. Consumers own recovery and proof of termination.

**Herdr pane**:
The terminal location in which a Pi agent runs, distinct from its containing tab or workspace.

**Herdr Pi agent**:
A named Pi process managed by Herdr in a specific pane. Its identity is not the conversation's display title.

**Pi-agent launch**:
The start of a named Pi agent in a selected Herdr pane, with caller-selected Pi resources and arguments.

**Shell readiness**:
Evidence that the selected pane's shell can receive the agent launch command, not merely that the pane exists.

**Pane contention**:
A launch refusal because the selected pane is already occupied. It is distinct from an unknown launch outcome.
