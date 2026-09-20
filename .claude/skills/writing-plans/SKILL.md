---
name: writing-plans
description: Use once a design is agreed (after brainstorming) and the task touches 3+ steps or multiple files — break it into a concrete written plan before touching code. Skip for single-file, single-step fixes.
---

# Writing plans

Прежде чем менять код в задаче из нескольких шагов — запиши план.

1. Разбей задачу на шаги по 5-20 минут каждый.
2. У каждого шага — конкретный файл(ы) и что именно там меняется.
3. Где применимо — сначала укажи, каким тестом/проверкой шаг подтверждается
   (запуск бота, ручной сценарий в Telegram, конкретный вход/выход ffmpeg).
4. Иди по шагам по порядку, не забегай вперёд и не смешивай несвязанные шаги
   в одном коммите.
5. Если по ходу выясняется, что план не работает — остановись, перепланируй,
   не продавливай изначальный план через силу.
