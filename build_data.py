#!/usr/bin/env python3
"""
국토교통부 아파트 매매 실거래가(개별 거래) + 서울 주민등록인구 -> 자치구별 집계

사용법 (프로젝트 루트에서):
  python scripts/build_data.py <원본CSV가 있는 폴더>

입력 파일명 (폴더 안):
  아파트_매매__실거래가_2005년.csv ... 2025년.csv
  주민등록_세대_및_인구__성별_연도별_구별__통계.csv

출력:
  data/price.js, data/population.js, data/price.csv, data/population.csv, data/price_detail.csv
"""
import sys, json
from pathlib import Path
import pandas as pd

YEARS = [2005, 2010, 2015, 2020, 2025]
PYEONG = 3.3058  # 1평 = 3.3058㎡
MIN_N = 10       # 거래 건수가 이보다 적으면 '표본 부족'으로 표시

GU_ORDER = ["종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구","강북구","도봉구",
            "노원구","은평구","서대문구","마포구","양천구","강서구","구로구","금천구","영등포구","동작구",
            "관악구","서초구","강남구","송파구","강동구"]

def main(src: Path, out: Path):
    rows = []
    seoul = {}
    for y in YEARS:
        d = pd.read_csv(src / f"아파트_매매__실거래가_{y}년.csv", encoding="cp949", skiprows=15, low_memory=False)
        d["구"] = d["시군구"].str.split().str[1]
        d["가격"] = pd.to_numeric(d["거래금액(만원)"].astype(str).str.replace(",", ""), errors="coerce")
        d["면적"] = pd.to_numeric(d["전용면적(㎡)"], errors="coerce")
        n_raw = len(d)
        d = d[d["해제사유발생일"].astype(str).str.strip() == "-"]      # 계약 해제 건 제외
        d = d.dropna(subset=["가격", "면적"])
        d = d[d["면적"] > 0]
        d["sqm_price"] = d["가격"] / d["면적"]
        g = d.groupby("구").agg(거래건수=("가격", "size"),
                               평균거래가=("가격", "mean"),
                               sqm_median=("sqm_price", "median"))
        g = g.rename(columns={"sqm_median": "㎡당중앙값"})
        g["평당가중앙값"] = g["㎡당중앙값"] * PYEONG
        g["연도"] = y
        seoul[y] = {"n": int(len(d)),
                    "sqm": int(round(d["sqm_price"].median())),
                    "pyeong": int(round(d["sqm_price"].median() * PYEONG)),
                    "avg": int(round(d["가격"].mean())),
                    "months": sorted(d["계약년월"].astype(str).str[4:].unique().tolist())[0] + "~" +
                              sorted(d["계약년월"].astype(str).str[4:].unique().tolist())[-1]}
        rows.append(g.reset_index())
        print(f"{y}: 원자료 {n_raw:,}건 -> 사용 {len(d):,}건 (해제 {n_raw-len(d):,}건 제외), {g.shape[0]}개 구")
    price = pd.concat(rows)
    price["표본부족"] = price["거래건수"] < MIN_N

    pop = pd.read_csv(src / "주민등록_세대_및_인구__성별_연도별_구별__통계.csv", encoding="utf-8-sig", skiprows=[1])
    pop = pop[pop["통계연도"].isin(YEARS)]

    out.mkdir(exist_ok=True)
    price.round(1).to_csv(out / "price_detail.csv", index=False, encoding="utf-8-sig")

    # --- population.js / csv
    pop_data, price_data, detail = {}, {}, {}
    for y in YEARS:
        p = pop[(pop["통계연도"] == y) & (pop["구명"] != "계")].set_index("구명")["인구수"]
        pop_data[y] = {gu: int(p[gu]) for gu in GU_ORDER}
        q = price[price["연도"] == y].set_index("구")
        price_data[y], detail[y] = {}, {}
        for gu in GU_ORDER:
            if gu in q.index:
                price_data[y][gu] = int(round(q.loc[gu, "평당가중앙값"]))
                detail[y][gu] = {"n": int(q.loc[gu, "거래건수"]),
                                 "avg": int(round(q.loc[gu, "평균거래가"])),
                                 "sqm": int(round(q.loc[gu, "㎡당중앙값"])),
                                 "low": bool(q.loc[gu, "표본부족"])}
            else:
                price_data[y][gu] = None
                detail[y][gu] = {"n": 0, "avg": None, "sqm": None, "low": True}

    (out / "population.js").write_text(
        "// 서울 25개 구 주민등록인구 (2005·2010·2015·2020·2025)\n// 출처: 서울 열린데이터광장 주민등록 세대 및 인구\n"
        f"const POPULATION_DATA = {json.dumps(pop_data, ensure_ascii=False, indent=2)};\n", encoding="utf-8")
    (out / "price.js").write_text(
        "// 서울 25개 구 아파트 평당가 = 전용면적 ㎡당 거래가 중앙값 × 3.3058 (만원/평)\n"
        "// 출처: 국토교통부 아파트 매매 실거래가 (계약 해제 건 제외)\n"
        f"const PRICE_DATA = {json.dumps(price_data, ensure_ascii=False, indent=2)};\n\n"
        "// 구별 상세: n=거래건수, avg=평균 거래가(만원), sqm=㎡당 중앙값(만원), low=표본 부족(10건 미만)\n"
        f"const PRICE_DETAIL = {json.dumps(detail, ensure_ascii=False, indent=2)};\n\n"
        "// 서울 전체: 모든 거래를 합친 ㎡당 중앙값 기반 평당가(pyeong), 거래건수(n), 평균 거래가(avg), 계약월 범위(months)\n"
        f"const SEOUL_STATS = {json.dumps(seoul, ensure_ascii=False, indent=2)};\n", encoding="utf-8")
    pd.DataFrame(pop_data).T.rename_axis("year").to_csv(out / "population.csv", encoding="utf-8-sig")
    pd.DataFrame(price_data).T.rename_axis("year").to_csv(out / "price.csv", encoding="utf-8-sig")
    print("완료:", out)

if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    main(src, Path(__file__).resolve().parent.parent / "data")
