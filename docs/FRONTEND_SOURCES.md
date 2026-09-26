# Frontend source provenance

This frontend adapts marketplace layout and styling from the user's read-only
`bnbera` repository checkout, at source tree commit
`e8d5c8ae46c1ae3875697901ebd0cc90c4f2c0b7`. The user explicitly authorized
reuse from that repository for this application.

| Donor source | SHA-256 | Adapted here |
| --- | --- | --- |
| `apps/web/app/globals.css` | `5ba6a39e004615c788db2151df7ebe884d9bf31c7c682ae45cb2866dc3b30b95` | Base dark color tokens, typography, layout and responsive rules in `app/globals.css`. |
| `apps/web/app/marketplace-theme.css` | `f59a3b0bc8c8459c220eae289ca8fbaf6f1b050b4eeca5baa1a2c0fc58aab91d` | Marketplace rows, filters, forms, detail panels and badges in `app/marketplace-theme.css`. |
| `apps/web/src/components/app-navigation.tsx` | `9ecfe416915c16aab19d468e46f80b5a68aed7b4494c2de3473c9527a7ffde56` | Navigation structure in `app/components/app-navigation.tsx`, reworked for ask2human, mainnet USDC and Slush wallet access. |
| `apps/web/src/components/agent-card.tsx` | `9ad63dd8d67569c2fa9d73503df945cac60924b4cb409c32e4f5fe3a24f21240` | Replaced the donor card content with live task rows in `app/components/experience-pages.tsx`. |
| `packages/ui/src/components.tsx` | `1ec202f7e5acdbd4d60a403f432b4ed9ce5052196e0be6837989ad755bc4fefe` | Small presentational primitives adapted into `app/components/ui.tsx`. |

These are adaptations, not a wholesale application port. The product flow,
identity, evidence, task records, approvals, and transaction behavior use this
repository's `docs/API.md` contract. Donor BNB, Altana, agent-registry,
marketplace data, and backend dependencies were not copied.
