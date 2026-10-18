# Adds MiniMax-M3.1-Flash-Preview to pi's built-in `minimax` provider in ~/.pi/agent/models.json.
# pi's catalog lacks it; plan-minimax-m3 routes writers and the refuter to it.
# Only appends the model when its id is missing: other providers, keys and existing entries stay as they are.
{
  "id": "MiniMax-M3.1-Flash-Preview",
  "name": "MiniMax M3.1 Flash Preview",
  "contextWindow": 1000000,
  "maxTokens": 131072,
  "input": ["text", "image"],
  "reasoning": true
} as $model
| .providers.minimax.models = ((.providers.minimax.models // [])
    | if any(.[]; .id == $model.id) then . else . + [$model] end)
