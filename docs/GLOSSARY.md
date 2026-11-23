# Domain glossary

Use these terms in product discussions, issues, and AI prompts. Add a term when its meaning affects a product decision or when two terms are easy to confuse.

## Chat

| Term | Meaning |
| --- | --- |
| Chat | The conversation surface for written messages, replies, and offers. |
| Conversation | A thread of messages across multiple turns. |
| User Message | A request the user sends to Lulu. Retrying the same request represents the same message. |
| Assistant Message | A reply delivered in Chat as text, a longer Markdown reply, or a Card. |
| Acknowledgement | A short Assistant Message confirming that Lulu received the request and will work on it. |
| Final Reply | The answer or outcome that completes a request. |
| Delivery Receipt | Confirmation that the app received a specific Final Reply. |
| Dictation | Turning spoken words into draft text for the user to review and send. |
| Voice Call | A live, spoken conversation with Lulu. Work can continue in the background while the call stays available. |

## Panel and Assets

| Term | Meaning |
| --- | --- |
| Card | A Chat message that shows a Widget or file the user can keep. |
| Offer | A Card inviting the user to keep something. It remains a proposal until the user accepts it. |
| Keep | Accepting an Offer in Chat. A Widget goes to Panel and a file goes to Assets. Keeping a newer revision of a Widget updates it in place. |
| Drop | Removing a kept Widget or Asset from the user's collection. |
| Panel | The collection of Widgets the user has kept. |
| Widget | A named item on Panel, such as a Checklist, Space, or Schedule Overview. Successive revisions of the same Widget retain its identity. |
| Checklist | A Widget of individually checkable items. The user can ask Lulu to turn an earlier reply into a Checklist. On iOS, completed items hide and a finished Checklist frees a Panel slot while its checkmarks stay saved. |
| Space | An interactive Widget with its own page, preview, and saved state. A new offer is a preview of a proposed revision, and keeping it makes that revision current. |
| Space Preview | The cover shown on a Space Card before opening the page. Preview interactions are temporary. |
| Space State | Information the Space page saves for the user's future visits. |
| Space Refresh | Updating the data shown in a Space. A refresh can be requested by the user, follow a schedule, or follow a monitored source. |
| Space Monitor | A watch on a source that updates a kept Space when relevant data changes. The monitor begins when the user keeps the offer. |
| Artifact | A saved file or page with one or more versions. A particular version identifies the content at the time it was saved. |
| Asset | A particular Artifact version the user has kept. An HTML Asset is a finished snapshot of the page as saved. |
| Assets | The collection of files the user has kept. |

## Delegation and scheduling

| Term | Meaning |
| --- | --- |
| Delegate | A background assistant assigned work by the main assistant. |
| Delegate Run | One assignment to a Delegate. A new run starts with its own conversation and the context supplied with the assignment. Its outcome returns to the main assistant. |
| Resume | Continuing an existing Delegate Run with its previous conversation. |
| Sandbox Workspace | The working area for delegated commands and files. A Delegate can save an Artifact when the user needs to keep the result. |
| Scheduled Job | An instruction to act once or daily at a specified time. Each due date and time is an occurrence. |
| Scheduled Task | A Scheduled Job that starts work for Lulu to perform. |
| Alarm | A Scheduled Job that sends a reminder to the user in Chat. |
| Dispatched | The due occurrence has started a Delegate Run or entered Chat for delivery as an Alarm. |
| Schedule Overview | A Widget that lists Alarms and Scheduled Tasks. Its Offer shows a snapshot. Once kept, it shows the current schedule. |

## Memory and connections

| Term | Meaning |
| --- | --- |
| Memory | Information Lulu retains for future conversations. |
| Memory Source | Dialogue, a kept Space or Asset, or saved Space state that can inform Memory. |
| Dreaming | Background work that turns Memory Sources into published Memory. |
| Memory Resource | A published piece of Memory with a summary and references to where it came from. |
| Memory Injection | Relevant Memory selected as context for a particular user request. |
| MCP Connection | A configured connection that makes another service's capabilities available to Lulu. Some connections require the user to sign in. |
