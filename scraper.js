name: ScorePop Gecmis Maclar Botu

on:
  schedule:
    - cron: '0 1 * * *'
  workflow_dispatch:

jobs:
  scrape-matches:
    runs-on: ubuntu-latest

    steps:
      - name: Kodları Sunucuya Çek
        uses: actions/checkout@v3

      - name: Node.js Kurulumu
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Puppeteer Yükle
        run: |
          npm init -y
          npm install puppeteer

      - name: Botu Çalıştır ve Skorları Topla
        run: node scraper.js
