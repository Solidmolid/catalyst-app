# Catalyst App

Die Handy-App zum [Catalyst](https://github.com/Solidmolid/Catalyst)-Radar: dein Depot,
die Meldungen des Depot-Wächters und der Tages-Radar mit KI-Einordnung. Läuft als
installierbare Web-App über GitHub Pages:
**https://solidmolid.github.io/catalyst-app/**

## Wie es funktioniert

- Der Catalyst (privates Repo) schreibt seine Ergebnisse nach Supabase: stündlich die
  Depot-Lage und neue Meldungen (GitHub Actions), täglich den Tages-Radar.
- Diese App liest sie nach dem Login (dasselbe Konto wie Momentum). Supabase gibt die
  Daten nur an dieses eine Konto heraus (Row Level Security); die App selbst kann
  nichts schreiben.
- Im Code steht nur der öffentliche Publishable Key. Der geheime Schlüssel zum
  Schreiben liegt ausschließlich in den GitHub-Secrets bzw. der lokalen `.env` des
  Catalyst.

## Aufs Handy

- **iPhone (Safari):** Seite öffnen → Teilen → „Zum Home-Bildschirm“.
- **Android (Chrome):** Seite öffnen → Menü ⋮ → „App installieren“.

## Hinweis

Nur Fakten, eigene Marken und klar gekennzeichnete KI-Meinung — keine Anlageberatung.
