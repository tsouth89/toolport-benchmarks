# Toolport lazy-discovery: standing-context token savings

Tokenizer: tiktoken `o200k_base` (GPT-4o/5 family).

Lazy meta-tool set (4, the default lazy `tools/list`): toolport_status, toolport_search_tools, toolport_call_tool, toolport_fetch_result.

Lazy standing cost is constant across catalogs: **781 tokens**.

| Catalog | Tools | Full tokens | Lazy tokens | Standing reduction |
|---|--:|--:|--:|--:|
| Stripe | 587 | 415,391 | 781 | 99.8% |
| GitHub | 1194 | 351,579 | 781 | 99.8% |
| OpenAI | 242 | 299,654 | 781 | 99.7% |

> **Honesty caveat.** This is the *standing* context cost (tools always in context). Lazy mode adds per-search result tokens when the model calls `toolport_search_tools`, and those results return a handful of tools' schemas. The standing reduction above is the headline; the amortized savings for a given session depends on how many DISTINCT tools it actually uses. We report the standing reduction and state this plainly - we do not claim the full % as an end-to-end session saving.
