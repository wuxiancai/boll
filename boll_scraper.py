import re
import time
from datetime import datetime
from playwright.sync_api import sync_playwright


TARGET_URL = "https://www.binance.com/zh-CN/futures/BTCUSDT"


def find_and_enable_boll(page):
    """Try to enable/show BOLL indicator on the chart UI.
    This is heuristic, aiming for simplicity and robustness.
    """
    page.set_default_timeout(15000)

    # Try open indicator panel (text may be Chinese "指标" or English "Indicators")
    candidates_open = [
        'button[aria-label="Indicators"]',
        'button[aria-label="指标"]',
        "text=指标",
        "text=Indicators",
    ]

    opened = False
    for sel in candidates_open:
        loc = page.locator(sel)
        if loc.count() > 0:
            try:
                loc.first.click()
                opened = True
                break
            except Exception:
                pass

    if opened:
        # Try to search and click BOLL/布林带
        search_input = page.locator('input[placeholder*="搜索"], input[placeholder*="Search"]')
        try:
            if search_input.count() > 0:
                search_input.first.fill("BOLL")
                time.sleep(1)
        except Exception:
            pass

        click_candidates = [
            "text=BOLL",
            "text=布林带",
            "text=Bollinger",
            "text=Bollinger Bands",
        ]
        for s in click_candidates:
            loc = page.locator(s)
            if loc.count() > 0:
                try:
                    loc.first.click()
                    break
                except Exception:
                    pass

        # Close panel to expose legend
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass


def extract_boll_values_from_html(html: str):
    """Extract BOLL values by regex from page HTML.
    Tries to capture three numeric values that usually appear after BOLL legend.
    Returns a tuple of strings or None.
    """
    # Common patterns near legend might include three numbers for upper/middle/lower
    patterns = [
        r"(?:BOLL|布林带)[^\d]*([\d.,]+)[^\d]+([\d.,]+)[^\d]+([\d.,]+)",
        r"(?:Bollinger(?:\s*Bands)?)[^\d]*([\d.,]+)[^\d]+([\d.,]+)[^\d]+([\d.,]+)",
    ]
    for p in patterns:
        m = re.search(p, html, flags=re.IGNORECASE | re.DOTALL)
        if m:
            return m.group(1), m.group(2), m.group(3)
    return None


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ])
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/118.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1400, "height": 900},
            locale="zh-CN",
        )
        page = context.new_page()
        page.goto(TARGET_URL, wait_until="networkidle")

        # Heuristically try enabling BOLL indicator
        find_and_enable_boll(page)

        # Poll and print values continuously
        print("开始实时爬取并打印 BOLL 值... (Ctrl+C 退出)")
        while True:
            try:
                # Use page content each tick; TradingView legend is often DOM text
                html = page.content()
                values = extract_boll_values_from_html(html)
                if values:
                    upper, middle, lower = values
                    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    print(f"[{ts}] BOLL 上轨:{upper} 中轨:{middle} 下轨:{lower}")
                else:
                    # If not found, try once again to enable BOLL
                    find_and_enable_boll(page)
                    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    print(f"[{ts}] 未找到BOLL数值，已尝试重新启用指标...")
            except KeyboardInterrupt:
                break
            except Exception as e:
                ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                print(f"[{ts}] 发生错误: {e}")
            time.sleep(3)

        browser.close()


if __name__ == "__main__":
    main()