# Velvet 3.0.0

*[English version below](#velvet-300--english)*

Большое обновление: исправлены зависание и звук в Windows, появились «Моя волна», микс дня, радио по треку,
лайки и дизлайки, умные плейлисты, BPM и тональность, вид плитками, заметки и текст песен по словам.
Данные переносить не нужно: медиатека, плейлисты, настройки и статистика подхватываются как есть.

Ниже — все изменения после версии 2.1.

## Исправлено

- **Зависание в Windows: нет звука, приложение не закрывается.** Обложка трека для системной панели Windows
  загружалась так, что главный поток окна мог остановиться — пропадал звук, а окно закрывалось только через
  Диспетчер задач. Обложка теперь отдаётся без блокировки, работа с диском и сетью убрана с главного потока.
- **Закрытие.** После нажатия ✕ или «Выход» процесс завершается сам не позже чем через 6 секунд, даже если
  что-то зависло.
- **Звук.** Файлы идут через локальный сервер Velvet; если этот способ не сработал, трек сам загружается вторым
  способом с той же позиции. Если через эффекты ничего не слышно, Velvet переключается в «Простой режим звука»
  (без эффектов и громкости выше 100%) и сообщает об этом. Исправлена тишина после быстрого «пауза → играть».
- **Мини-плеер** не открывался в Windows — исправлено.
- **Скорость, привязанная к треку.** Скорость, выставленная ползунком, не сохранялась, хотя появлялось
  «Привязано». Теперь сохраняется любая скорость с эффектами и применяется сама, в том числе после перезапуска.
- **Диагностика.** Кнопка «Проверить звук» в настройках и журнал
  `%LOCALAPPDATA%\app.velvet.player\logs\velvet.log`.

## Рекомендации

- **Моя волна** — бесконечный поток по вашему вкусу. На карточке выбираются режим («Любимое», «Баланс»,
  «Открытия») и источник новых треков (Авто, SoundCloud, YouTube). Волна начинает играть сразу со своих треков,
  новые добавляются по мере нахождения.
- **Подбор по жанру.** Новое ищется от ваших же треков: «похожие треки» SoundCloud или «Микс» YouTube, плюс
  исполнители, похожие на ваших. Жанр определяется по тегу, по словам в названии (phonk, funk, montagem…) и по
  жанру страницы SoundCloud. Сборники, часовые миксы и чужие жанры отбрасываются.
- **Микс дня** — до 6 автоплейлистов по жанрам и настроению, обновляются каждый день.
- **Забытые треки** — любимое, что не звучало больше 45 дней.
- **Новое для вас** — сначала «В вашем жанре», потом «Рядом с вашим вкусом»; отрывок, скачивание, радио.
- **Радио по треку** — бесконечная очередь похожих треков в жанре исходного. Новые треки играют из интернета без
  скачивания; без интернета радио собирается из медиатеки.
- **👍 и 👎.** Лайк учит рекомендации и ничего не скачивает. Дизлайк убирает трек, после двух отказов — и
  исполнителя. Все оценки видны и отменяются в настройках.
- **Следующий трек готовится заранее** — переход между треками идёт без паузы.

## Поиск

- Источник выбирается раскрывающимся списком: SoundCloud (по умолчанию), YouTube, Spotify. Выбор запоминается.
- Поиск Spotify по вашим собственным ключам (Настройки → Импорт). Звук для прослушивания и скачивания берётся с
  YouTube или SoundCloud.

## Медиатека

- **Умные плейлисты** по правилам: прослушивания, избранное, дата добавления, «не играл N дней», жанр,
  исполнитель, год, BPM, тональность, длительность, источник, заметка. Есть готовые шаблоны, например
  «Часто слушаю, но не в избранном» и «Добавлено за неделю».
- **BPM, тональность и энергия** определяются в фоне; колонка и сортировка по ним. Жанр и год для треков без
  тегов подтягиваются из интернета (можно выключить).
- **Плитки** — переключатель «Строки / Плитки» на всех страницах со списками треков.
- **Заметки** к трекам, плейлистам и умным плейлистам; поиск по медиатеке ищет и в заметках.
- **Статистика** по жанрам и десятилетиям.

## Тексты песен

- Подсветка идёт по тому, что реально слышно: учитываются задержка вывода звука и скорость воспроизведения.
- **По словам** — переключатель во вкладке «Текст». Если в тексте нет меток слов, время слов оценивается по
  слогам и темпу пения.
- Для версий slowed, sped up и nightcore берётся текст оригинала и растягивается под длину файла.
- Кнопки «− / +» сдвигают текст на 0,1 с для конкретного трека.

## Discord

- Обложка в активности: сначала поиск в интернете, затем своя обложка трека, иначе логотип Velvet. Своя обложка
  загружается уменьшенной копией на catbox.moe по публичной ссылке; загрузку можно выключить в настройках.

## Что стоит знать

- Для поиска и рекомендаций Spotify нужны свои ключи; владельцу приложения Spotify с 2026 года нужен Premium.
- Жанр уже скачанных треков SoundCloud уточняется в фоне постепенно, поэтому точность волны растёт со временем.
- Время слов в тексте без меток — приближение; для неточных текстов есть ручная подстройка.
- Сборка: `npm install`, затем `npm run dist:win`. Требования не изменились.

---

# Velvet 3.0.0 — English

A major update: the freeze and the missing sound on Windows are fixed, and Velvet gains My wave, daily mixes,
track radio, likes and dislikes, smart playlists, BPM and key detection, a tile view, notes and word-by-word
lyrics. Nothing needs migrating: your library, playlists, settings and statistics are picked up as they are.

Everything below has changed since version 2.1.

## Fixed

- **Freeze on Windows: no sound, the app would not close.** The track cover for the Windows media overlay was
  loaded in a way that could stall the window's main thread — playback went silent and the window could only be
  closed from Task Manager. The cover is now served without blocking, and disk and network work is off the main
  thread.
- **Quitting.** After ✕ or "Quit" the process ends by itself within 6 seconds, even if something hangs.
- **Sound.** Files are read through Velvet's local server; if that fails, the track is loaded the other way from
  the same position. If nothing can be heard through the effects, Velvet switches to "Simple sound mode" (no
  effects, no volume above 100%) and says so. Silence after a quick pause → play is fixed.
- **Mini player** did not open on Windows — fixed.
- **Speed bound to a track.** A speed set with the slider was not saved although "Bound" was shown. Any speed
  with its effects is now saved and applied automatically, also after a restart.
- **Diagnostics.** A "Check sound" button in Settings and a log at
  `%LOCALAPPDATA%\app.velvet.player\logs\velvet.log`.

## Recommendations

- **My wave** — an endless stream for your taste. Its card lets you choose the mode (Favourites, Balance,
  Discover) and where new songs come from (Auto, SoundCloud, YouTube). The wave starts at once with your own
  songs; new ones join as they are found.
- **Genre-aware picks.** New songs are found from your own songs: SoundCloud's related tracks or YouTube's Mix,
  plus artists similar to yours. The genre comes from the tag, from words in the title (phonk, funk, montagem…)
  and from the SoundCloud page. Compilations, hour-long mixes and unrelated genres are dropped.
- **Daily mix** — up to 6 automatic playlists by genre and mood, new every day.
- **Forgotten tracks** — favourites you haven't played for more than 45 days.
- **New for you** — "In your genre" first, then "Close to your taste"; preview, download, radio.
- **Track radio** — an endless queue of similar songs in the seed's genre. New songs play from the internet
  without downloading; offline, the radio is built from your library.
- **👍 and 👎.** A like teaches the recommendations and downloads nothing. A dislike removes the song, and after
  two refusals the artist. All ratings can be seen and taken back in Settings.
- **The next track is prepared ahead** — tracks change without a pause.

## Search

- The source is chosen from a drop-down list: SoundCloud (default), YouTube, Spotify. The choice is remembered.
- Spotify search with your own keys (Settings → Import). Audio for previews and downloads comes from YouTube or
  SoundCloud.

## Library

- **Smart playlists** built from rules: plays, favourites, date added, "not played for N days", genre, artist,
  year, BPM, key, length, source, note. Templates are included, such as "Played often, not liked" and "Added
  this week".
- **BPM, key and energy** are detected in the background, with a column and sorting. Genre and year for tracks
  without tags are looked up online (can be turned off).
- **Tiles** — a List / Tiles switch on every page with a track list.
- **Notes** for tracks, playlists and smart playlists; library search looks in notes too.
- **Statistics** by genre and decade.

## Lyrics

- The highlight follows what is actually heard: output latency and playback speed are taken into account.
- **By words** — a switch on the Lyrics tab. When the lyrics have no word timestamps, word times are estimated
  from syllables and the singing pace.
- Slowed, sped-up and nightcore versions use the original's lyrics, stretched to the file's length.
- The "− / +" buttons shift the lyrics by 0.1 s for a single track.

## Discord

- Activity cover: an online lookup first, then the track's own cover, otherwise the Velvet logo. The track's own
  cover is uploaded as a small copy to catbox.moe under a public link; this can be turned off in Settings.

## Good to know

- Spotify search and recommendations need your own keys; since 2026 the owner of a Spotify app needs Premium.
- Genres of SoundCloud tracks downloaded earlier are refined gradually in the background, so the wave gets more
  accurate over time.
- Word times in lyrics without word timestamps are an estimate; a manual shift is there for imprecise lyrics.
- Build: `npm install`, then `npm run dist:win`. Requirements are unchanged.
