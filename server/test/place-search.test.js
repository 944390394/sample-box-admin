import test from "node:test";
import assert from "node:assert/strict";
import { readRegionCode, searchPlaces } from "../src/geo/placeSearch.js";

const reply = (body) => async (url) => {
  reply.last = decodeURIComponent(url);
  return { ok: true, text: async () => `var tdt_loadResult=${JSON.stringify(body)};` };
};

test("地名搜索：全国命中多个省时返回省列表，指定市返回带省市区的地址", async () => {
  const stats = await searchPlaces({
    tk: "k",
    keyword: "合力家园",
    fetchImpl: reply({
      count: 8,
      resultType: 2,
      statistics: {
        allAdmins: [
          {
            adminName: "安徽省",
            count: 7,
            adminCode: "156340000",
            isleaf: false,
            lonlat: "117.27,32.44",
          },
        ],
      },
    }),
  });
  assert.equal(stats.kind, "regions");
  assert.deepEqual(stats.items[0], {
    name: "安徽省",
    code: "156340000",
    count: 7,
    leaf: false,
    lng: 117.27,
    lat: 32.44,
  });
  assert.match(reply.last, /"queryType":1/);

  const pois = await searchPlaces({
    tk: "k",
    keyword: "合力家园",
    region: "156340100",
    fetchImpl: reply({
      count: 7,
      resultType: 1,
      pois: [
        {
          name: "合力家园(一村)",
          address: "望江西路60号",
          province: "安徽省",
          city: "合肥市",
          county: "蜀山区",
          typeName: "小区",
          lonlat: "117.254769,31.833011",
        },
      ],
    }),
  });
  assert.match(reply.last, /"queryType":12,.*"specify":"156340100"/);
  assert.equal(pois.kind, "pois");
  assert.equal(pois.items[0].address, "安徽省合肥市蜀山区望江西路60号");
  assert.equal(pois.items[0].lng, 117.254769);
});

test("地名搜索：区域码要 9 位国标码；服务出错不把密钥带进错误", async () => {
  assert.equal(readRegionCode("156340100"), "156340100");
  assert.equal(readRegionCode("3401"), "");
  assert.equal((await searchPlaces({ tk: "k", keyword: " " })).kind, "none");
  await assert.rejects(
    searchPlaces({
      tk: "secret-key",
      keyword: "x",
      fetchImpl: async () => ({ ok: true, text: async () => "var tdt_loadResult={error:'500'};" }),
    }),
    (error) => !String(error.message).includes("secret-key") && /暂时不可用/.test(error.message)
  );
});
