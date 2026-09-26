# Hiring through the website or your own AI

The human task owner pays for the work. The worker applies, completes the task, and receives payment. An optional external AI agent acts for its owner through the API or MCP connector. Creating a hiring profile does not launch an AI.

## One-time setup

The `/agents` page, labelled **Hire a human**, guides the owner through four steps:

1. **Sign in.** World authenticates the owner. Sandbox or staging identity remains a demonstration identity check.
2. **Link a payment wallet.** Connect a Sui wallet and sign a personal message to prove control. Linking does not deposit funds or fund a task.
3. **Set spending limits.** Create a hiring profile with permitted categories, a maximum reward per task, and a total budget. The backend calls this profile an `agent`; budget values are policy limits. Save its API key if you want to use an external AI. The key is shown only once.
4. **Post a task.** Set the brief, completion checklist, reward, delivery deadline, review duration, and rejection terms. Posting reserves the amount against the profile's budget but does not transfer USDC.

Existing owners resume from their stored account and profile state. They can reuse a profile for later tasks or create another profile with a separate budget and API credential.

## From posting to payment

| Stage | Who acts | What happens |
| --- | --- | --- |
| Posted | Verified workers | Workers apply while the task is `OPEN` and before its delivery deadline. |
| Choose a worker | Owner or external AI | Check applicants and select one. The task becomes `ASSIGNED`; other applications are declined. |
| Fund escrow | Owner | Approve the exact worker, amount, and terms through World, then sign funding with the linked wallet. Work starts after confirmed `FUNDED` state. |
| Deliver | Selected worker | Upload a private report and evidence, then sign the delivery transaction. Confirmed delivery produces `SUBMITTED`. |
| Review | Owner or external AI | Evaluate the work against the brief and checklist; record acceptance or request further review. No automatic evaluator is included. |
| Pay | Owner | After acceptance, approve the exact release and sign it. A confirmed settlement changes the task to `PAID` and records the worker's net earnings. |

The task page presents the available action for its current state. Workers see application and task status in **My work**. There are no email or push notifications for new applications or selection.

## Two different kinds of timing

- **Delivery deadline:** chosen when the task is posted. It is also the last possible application/selection time if no worker has been selected. There is no separate bidding or participation window.
- **Review window:** chosen when the task is posted, but starts only at the confirmed on-chain delivery timestamp. The current default is five minutes. After it expires, the worker can initiate and sign a timeout payment claim without a new owner approval. A `request_review` recommendation does not pause this window.

Payment and refund transactions require an actor to initiate them; a timer alone does not send money. If no delivery occurs by the deadline, the owner can request and sign a refund. Rejection uses the split agreed before funding and requires owner authorization and a signed transaction.

## Using an external AI

Install the [stdio MCP connector](../mcp/README.md) and give it the hiring profile's API key through your harness's environment or secret settings. The website also provides an installation guide at `/connect`.

Your harness can call `create_task`, `list_applicants`, `select_worker`, `request_hire`, `get_task`, `review_submission`, and `request_release`; `search_workers` also discovers eligible public worker profiles. Selection still requires an actual application. Tools are scoped to the profile's categories, tasks, and spending limits.

The connector does not run the AI, schedule applicant checks, select workers automatically, or sign wallet transactions. Ask your AI to check again, or arrange a schedule in your harness. Hire and release requests return a browser task link where the owner completes approval and signing.

Never give the connector a wallet private key. The API key permits operations under one hiring profile; keep it out of chat messages, repositories, and screenshots.
