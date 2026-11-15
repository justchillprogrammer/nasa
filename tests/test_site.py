"""Page-level checks that follow the judges' report: one design, credits,
no emoji, sharing basics, honest flagging, and every target shown."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PAGES = ["index.html", "explore.html", "how.html", "404.html"]
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-⛿✀-➿]")


def read(name):
    return (WEB / name).read_text(encoding="utf-8")


class TestEveryPage(unittest.TestCase):
    def test_shared_header_and_footer(self):
        for page in PAGES:
            html = read(page)
            self.assertIn('<header class="bar">', html, page)
            self.assertIn('class="site-nav"', html, page)
            self.assertIn('class="site-foot"', html, page)
            self.assertIn("Team Volunteers", html, page)
            self.assertIn("Mamatkarimov Mironshoh", html, page)
            self.assertIn("Doshniyazov Sardar", html, page)
            self.assertIn("not affiliated with or endorsed by NASA", html, page)

    def test_share_basics(self):
        self.assertTrue((WEB / "favicon.svg").exists())
        self.assertTrue((WEB / "og.png").exists())
        for page in PAGES:
            html = read(page)
            self.assertIn('rel="icon"', html, page)
            self.assertIn('property="og:image"', html, page)

    def test_plain_zero_font_and_no_emoji(self):
        for page in PAGES:
            html = read(page)
            self.assertIn("Public+Sans", html, page)
            self.assertNotIn("Atkinson", html, page)
            self.assertIsNone(EMOJI.search(html), f"{page}: emoji")
        for js in ["showcase.js", "app.js", "story.js"]:
            self.assertIsNone(EMOJI.search(read(js)), f"{js}: emoji")

    def test_explorer_has_no_giant_logo(self):
        html = read("explore.html")
        self.assertNotIn('class="home-link"', html)
        self.assertIn("Explore any spot in the sky", html)


class TestHomePage(unittest.TestCase):
    def test_every_target_is_shown_and_no_empty_more_cards(self):
        js = read("showcase.js")
        self.assertNotIn("g.items.length < 3", js)
        self.assertNotIn("function moreCard", js)
        self.assertIn("Find more in the Explorer", js)

    def test_cards_blink_softly_only_on_hover(self):
        css = read("story.css")
        self.assertIn(".card:hover .card-pics img.later", css)
        self.assertIn("soft-blink 1.6s", css)
        self.assertIn("prefers-reduced-motion", css)

    def test_search_box_on_home_page_exists(self):
        html = read("index.html")
        self.assertNotIn("at the top of the page", html)
        self.assertIn('class="cta-search"', html)
        self.assertIn('typed = (q.get("q")', read("app.js"))

    def test_badges_are_phrases(self):
        self.assertIn('"1 star moved"', read("showcase.js"))

    def test_tour_is_five_stops(self):
        self.assertIn("Take the tour (5 stops)", read("index.html"))
        self.assertNotIn("2-minute", read("index.html"))


class TestFlagging(unittest.TestCase):
    def test_no_default_answer_and_deliberate_click(self):
        html = read("index.html")
        self.assertIn('<option value="" selected disabled>Choose what you saw</option>', html)
        js = read("showcase.js")
        self.assertIn("function armFlag", js)
        self.assertIn("if (!S.flagArmed", js)

    def test_findings_can_be_shared_and_notes_are_escaped(self):
        js = read("showcase.js")
        self.assertIn("github.com/justchillprogrammer/nasa/issues/new", js)
        self.assertIn("${esc(f.notes)}", js)


class TestData(unittest.TestCase):
    def test_asteroids_are_on_the_home_page(self):
        idx = json.loads((WEB / "showcase" / "index.json").read_text(encoding="utf-8"))
        slugs = {t["slug"] for t in idx["targets"]}
        for s in ("psyche", "eros", "vesta"):
            self.assertIn(s, slugs)
            self.assertEqual(next(t for t in idx["targets"] if t["slug"] == s)["group"], "Moving objects")


if __name__ == "__main__":
    unittest.main()
