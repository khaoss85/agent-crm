import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateModuleMigration, validateModuleManifest } from '../packages/core/src/module-manifest.js';
import {
  generatePostgresModuleBootstrap,
  manifestRevision,
} from '../packages/core/src/module-evolution.js';
import {
  assertRevisionHistoryContract,
} from '../packages/core/src/record-module-history.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const sha = (sql) => createHash('sha256').update(sql).digest('hex');

/**
 * A manifest that changes its SQL without raising `revision` re-renders an
 * already-applied migration, and every database that recorded it fails with
 * MODULE_MIGRATION_CHECKSUM_MISMATCH (accordo 4c3ad4870a5f: b8266ea widened
 * the data-quality-issue `kind` enum without a revision bump, and the seed on
 * presti-group failed on `pg_bootstrap_data_quality_issues`).
 *
 * This guard pins the rendered migration SQL of every manifest-selected
 * module (each package's modules directory) at its recorded revision: any
 * manifest edit that changes the SQL must raise the revision, ship the
 * previous manifest in `<name>.history.json`, register it in
 * `packages/core/src/record-module-history.js`, and update RECORDED below —
 * all in the same PR. A SQL change with the revision untouched fails here,
 * on every PR, because this file is a repo-wide guard (see
 * `scripts/ci-touched-tests.js`): it walks the modules instead of importing
 * them, so the import mapping would never select it.
 *
 * The guard also enforces the history contract itself
 * (`assertRevisionHistoryContract`): a revision above 1 without a covering
 * history fails even when RECORDED matches the new current-manifest SQL —
 * that combination is exactly the b8266ea recurrence (old databases fail
 * while the guard stays green). Seven revision-2 modules predate the history
 * mechanism and are declared born at revision 2 in `BORN_AT_REVISION_2`
 * below — the declaration lives here, in the test, because the kernel
 * (`packages/core/src`) may not name a domain module in either direction.
 * The walk passes the declaration to `assertRevisionHistoryContract` as
 * `bornAtRevision`; it excuses exactly revision 2, and the next bump of any
 * of them ships history.
 */
const RECORDED = Object.freeze({
  "appointment": { revision: 2, sqlite: "64010d7ce093f774d18ed20c1ecb8afb407d7847f306ac4df3620ba90e0755ab", pg: "f0810edf2dcd053df71885516e95943df2749a06633224251f5a84daaab80f3e" },
  "calendar-link": { revision: 1, sqlite: "0833adb4ddf2a25a5232c66f768ea091da8f682072dbccd2045803ab4d6fcc99", pg: "537b281541bbe59a4423bf40c3c4af28cb12170c5e4d848ef2f235cf171c7592" },
  "calendar-sync-state": { revision: 2, sqlite: "9a07b39afe234be4acb2f910752cd359082628b3794ad9a89bb279f580f37d09", pg: "eca193443a3dcfe428760b31761f66ab1d5cd35125c53ee549ff23b80642111b" },
  "channel-connection": { revision: 3, sqlite: "64af6c70e065b58ca41f600139ecb27470d1190a261c0459a0dd66b3274c0bba", pg: "4c33f634ecd5168d0cba55ca50327520a1507ab55621d0073d8b4b325cd10403" },
  "channel-dead-letter": { revision: 1, sqlite: "60072cdc325757761651dced3c916f8d0222536e07a7312013a0a2b2b36f593c", pg: "a9181f22c8cda1fb7a9437fb3e613fa97e6a950e77247ae1e8b801dc819bd158" },
  "channel-import-outcome": { revision: 1, sqlite: "0394a9f9e93e3536bba9bfbeb0ced05e2afbe9d9536411dd5340d54c5dae3099", pg: "46f1ca44727782f41658d31183d8444d73b24fe34e8a2c64d1eb93890f54e886" },
  "channel-import-state": { revision: 1, sqlite: "97b88126f30e52267871c663b5bac8f2f89903b538c06fedd18b0f846ccac4f6", pg: "da084012fe0c2d863b0033a007c36d083a1871a6c03895b032bbdf2b25065f6c" },
  "channel-inbox-event": { revision: 1, sqlite: "1396d943cce41e642c8dc95b6cd6231bd3b340768789b9b8eedccac7d451e7c0", pg: "294f342f85a3fd3afd530e93de3a176de36d09bdbe3620312bfe0b72856cf872" },
  "catalog-sync-run": { revision: 1, sqlite: "75b045cc96a7e574c06a345a56fafa01c3c87b96b6d7e7b9c79991cc2ef1c0ac", pg: "34716c3381ef51eae501244aeeda7a75fa7c1ca942bf7cc0c6833842d9869b4c" },
  "package-credit": { revision: 1, sqlite: "f4ed8b2b2b75ee0c8170947b4d03ddc6e373f4c1b023f8ca0872e59ce3f82224", pg: "3c070dea5600b49cc9eb0f8a2eb519c6597fe8674995f009d96ccbcd3fa5a446" },
  "offer": { revision: 1, sqlite: "b4b95faa130fc8b638d31e2aa3041d09a04b06cfff58b7e5bbce5976893a6755", pg: "ec19280eb18a9a3f9927a6147e12c18d920f9a69c80ac1556ecc546def43563b" },
  "price-book": { revision: 1, sqlite: "8d4ba11f65b5361d56bc1fc4066499a3fc3ce8a7cc135d14e3761a8df94fc506", pg: "d30372805d2648dac1e9cb6e1929d0c34f124937ae41670f176f3b431fc1b531" },
  "price-component": { revision: 1, sqlite: "2dc66c47c6b6064b09c05433472e771f8387c1c1c9c8c292938776fd2c8a59b2", pg: "97c1aee62f29bb0d7aa99ed68d487b199cbf5b26e27f2cb8008e42a828eea490" },
  "price-tier": { revision: 1, sqlite: "71974683f1f965313014ec0e408ec533b76dfd60a7ec11a03a19241618d2a43f", pg: "8cd1b3197d75ea6b6b41824d9aab3a85a046b1c61a90072a44e4683cb6da9167" },
  "product-version": { revision: 2, sqlite: "04ac7b3db66b9fd2a0066422f8c383c2651f7e35af9d730df501bd5773df3d70", pg: "82b1e09e917ac8a281d603a5819bfe40486afefbe345a02f40bf0e0966a3676c" },
  "product": { revision: 1, sqlite: "858d4574ce96b4f775845105342bc456da1b22cb8935ef4cb8cb0ddc1f775b90", pg: "6ef4f2514efa89aaf2fac031f70dfa325606cc56270b30963714c6a80faa5023" },
  "product-import": { revision: 1, sqlite: "2f0606e38668fd7871b26aef6bad02f2645e512c4910c7e2b218b2c74a55a60d", pg: "8041436d56da09d32097d5ea2f757ff364812a2322ffb25f4db406d5ad1c3dc2" },
  "product-import-row": { revision: 1, sqlite: "ec415063d066d3fa71f12977dfd18ee7ce00750d4974febd57bb6808d40db1c9", pg: "0208a6291853fc0cbe3b316d809d022f0c8bcaf654a1a605752168c35fe4c1a5" },
  "quote-approval": { revision: 1, sqlite: "06f9cfa0058c61d71a27aa109b9a30e157b8a9c4ed1eef71497fc45743a30d29", pg: "bd6f310cec4195b717117efb8bb470e8f1c1658ff3ec8e1d5ad857673c41d8ff" },
  "quote-line": { revision: 1, sqlite: "fab522bf83d6fc1799c508d56b75627e540e4bf1dfb680ad2f02bc19c3c07231", pg: "e3cd324b3b64c4dd3c33aa08d7e658406ecf622a6ecdcc7d2fe20dc317d1a034" },
  "quote-term": { revision: 1, sqlite: "5793a73fb52dba142039a720c190cff949c152a9b35e47af2e08b8dfbc6bc89f", pg: "f8f2f3137bf52bd70520f3c9b966f2b9a807419889b8b5f1b6bbb0aae0db08a8" },
  "quote-version-component": { revision: 1, sqlite: "344758431ee636bed4411fa04a84d50e3df7d659a71d5f98806c5ece3c73c641", pg: "bcdeb18b608961d7480fdde8da78edeff9a9bdc62f0e64227a78b80643b89a1a" },
  "quote-version-line": { revision: 1, sqlite: "ae97d5d9538f1efdd2592f7ddce84b01ff815d3a10b01326b97d6fec56b3cd91", pg: "cc720d32def298dc3c5aa1e82353585e688c308f21855320d326716c3a81b6c0" },
  "quote-version-term": { revision: 1, sqlite: "0118f799a623bf9271b3de803c60d69d13a7339dfec5b0aa535071229309282e", pg: "3bf93abe80d48108b0be18ab497db3685e8634d6d005fd2eda2994d298255b8c" },
  "quote-version-total": { revision: 1, sqlite: "1f801091de1c1a25633d7c4be3858629e2fa26d555febc3f2134df30a36c572f", pg: "b8830b2fc0fc7cc20c68e285696b4f8dec091d407dde86a41bfe036decb7886a" },
  "quote-version": { revision: 1, sqlite: "521f4ea1dc6d1ecbb96957b158c529cbed20c2ffffc073ebef44b9750e28159b", pg: "4f0fef746b3178793ee0e11c6d8090eb171c7ea25f3ba577f953afd39864eed2" },
  "quote": { revision: 1, sqlite: "e77c292ea6a809fcf5ee9e0001b883148fc2a68340eda47dc9b750f6114106db", pg: "ae8cdd06674f5ea895355cc64c94644df8d310449c4c0be9bb1084bd2dd27cd2" },
  "commercial-contract": { revision: 2, sqlite: "461a12a2279c801460d6cd2034f90bb9eb48049fba12647564061ce0012e4b43", pg: "c9db074e6e65ce4383b317eb3705d53ed41cbea510796d67dd305ba5f3ed1bcb" },
  "contract-activation": { revision: 2, sqlite: "32373dde9a63179bb6a290cdf316b61142d94058348a68c43bae25b7e931c4bb", pg: "c2dd2e56e56ddb3b5c779e8c2077f1248a18923c7453b02ed202667844b0cbb0" },
  "contract-line": { revision: 1, sqlite: "aef4381bd0b96accb67dcf1589cc8a9b790f70555c17d38846a6cee6e14362f8", pg: "d3d6ba5a55b72ca2bf2d97c3f945de03354e1ec344bbf0858bd4b2b1c054267f" },
  "contract-succession": { revision: 1, sqlite: "cf3d75ec7326a407d3adae7c55394659978dda058d894f6062d019d6c892118d", pg: "6432826097ebc62af7f98ee182caa3bcfcf524612276d4b4df7140e52afa88e1" },
  "contract-version": { revision: 2, sqlite: "c25cdea9a94bc0a37541e3b113dfec88cb94c885b4086fbed52a164f0ba49f41", pg: "a574fc684df4d27fc4c7c021543a6f311f111798b3cce9e0f9e58d5aadaa1ed5" },
  "delivery-obligation": { revision: 1, sqlite: "f5d6ffa3286fb31495d146d6778f3b1d41ecc12f2bc15c6633de6134c0ec6023", pg: "439e92ce147cdd93ddfd4d420bacf8a82f4ec99171abbe4e7cd4780963adafdb" },
  "service-obligation": { revision: 2, sqlite: "5df3cbfa99e7e2fdbc1f007c9f2ea165586812451c6f58360994427cebbd4fae", pg: "69df63de8e966b8a5da81cba80306b15b477cf58055145cb65d4d38f10444db2" },
  "subscription-line": { revision: 1, sqlite: "43f7fff1c417d7b9a4618f1d09ce5f91fe51918334dec0c1d7022912f1545510", pg: "9d96874e1078035a3f079d4db8baa021808d184671e393f1a89900afcf19c0f2" },
  "subscription": { revision: 1, sqlite: "7fa5b3ef6e4624b0d2a2160517b6abe4cbbea815024b02b16a4d18d618cff6d7", pg: "5e966c0d130c048acad5ab8b1f90006c9c5017244954999cd687a003e83622fd" },
  "canonical-link": { revision: 1, sqlite: "e0f7d850e51c348a1dff2ac7569b3cfc73de2de8a9e3ab5b588d7974fb28927a", pg: "1aabbe65c7ee0e8a5957f1d1b68cddf56b907c0eaa05c39d98045c0fe05a8013" },
  "customer-bulk-item": { revision: 1, sqlite: "080d90a523699c840cc416a07bd214081129a1dd2b26a8f45ac34833680b53ab", pg: "bf38935f0a56949c3a564e6bd03379ef7e2748e016b87308ff1ead62853dc33f" },
  "customer-bulk-run": { revision: 1, sqlite: "99a8e63e719c4a16483f7bd124b7137ddbe325e3ee6619b90e270625f622f650", pg: "a5ee383090ba95b39eb664f51e4252b5117adb995e6572d04946b9add0219e9e" },
  "customer-import-row": { revision: 1, sqlite: "1fd036ec93f7524f3c3649513de7cea9121975fa9a8e838492084443e81d0a95", pg: "fd3b433c861e4e0230951538a0fc4b5ac2c1f13cbaef6df298ced5f66ba21521" },
  "customer-import-run": { revision: 1, sqlite: "862a20a5645c9d0e76025994e1b36c03cb78d1ad7549458c850c7c59287db518", pg: "4a9f9bb2229938861a1481fc56b2f42eedcea9f2b8d078576133be30bb7a5832" },
  "data-quality-issue": { revision: 2, sqlite: "b08c6b8c1e2182fc432cdb77417541416a44b7301e3c01f01a88a99b230de656", pg: "44aec90d03eb7f00803870bf7b18201100e008d6be97ef8153918100c6a565cf" },
  "duplicate-candidate": { revision: 1, sqlite: "21ea35b59c6903bc8ebe9f08b80eab64d0c3f31103bddcb55f3b548e81ab6d71", pg: "a293307bf8b26661912cc5e5f0a4804e8ea4b86bae830cee070d0d985918d1b9" },
  "enriched-field": { revision: 1, sqlite: "763e9afa35f299980ca88986afa0906717d0b0e6f2d35816bf4c70ad22995239", pg: "b89b8a3eeee3a9a4a5b0e2a3cb30211f6d6b5e92ca1bdbf3c3310ef5b020840b" },
  "enrichment-opt-out": { revision: 1, sqlite: "7c4c20685c2f6f98d255dd2b7f5e8304700e80d80a92d4151dd07dba7181e42a", pg: "6f751aabef31bc38d0ae3f3c4236161a08e3711e2ae72b85474c7e57614cea2c" },
  "external-identity": { revision: 1, sqlite: "d5db3f31a322009dc197a56400384a69cf90a90c34dad4767a528c4cb66a4272", pg: "c978464ecc4540266ab2bd26225e9238a801086f1e428f36c183e5858015030e" },
  "delivery-acceptance-evidence": { revision: 1, sqlite: "dc044031292bff40169c34a18086a1dbe78a2836bc661f46a557a3a6c2cd23d5", pg: "6cebef1df565bf0c1dda9c2e4636cb2da7a22e062dab788e8be5157d775cbe13" },
  "delivery-acceptance-request": { revision: 1, sqlite: "5e7864b8ec1c2af393bfbed195dade435571e46b1aa69434fc81c5d34f8d1113", pg: "0041226ad377733b2129b4dce40fb26d4f5443727b1ab0d13f37024f8ad193ca" },
  "delivery-change-request": { revision: 1, sqlite: "340375073eba41036462e845da2f46737ac4c79c9e648956b65dccee045a7599", pg: "4b718b7b75c4c58b5d015b0a46b357893bc59168bc66c04da8954a1ae53528d1" },
  "delivery-commercial-change": { revision: 1, sqlite: "61a204f6da1ead1d4809bcbd19d4c3288a6ba8409f6a8d35a8d1c30c6f617d29", pg: "6117e9b82a0ef3a348a608072b0ba16dac3445f24a65fed077e9ea874deeb068" },
  "delivery-deliverable": { revision: 1, sqlite: "8149b47d0899c475c9ab70ee1d522b464c653b5b310a0e09b0aff89b6ee4a9b1", pg: "d5ddfe198cf48e722a0b683a2fab26d2ff1355ac7898410db40723dc9e5c0274" },
  "delivery-economic-plan-line": { revision: 1, sqlite: "02c1219f71e30c8d19bf5dfc960a88e8beff6476e0b1d8cdadf9d3a83dfdd035", pg: "8e309dd0eb041fea5bd82eda70cfbc8aa6b62db4cc60bc7699bcf9049d4d799f" },
  "delivery-economic-plan": { revision: 1, sqlite: "2c217654cd3904b7bb805a15e64ff82558ecac12d78e64a8e4b36409c484e837", pg: "dfeb12400a2144c758c867199cc560d78259911c6c19d64c0ebf1f4bf9176b74" },
  "delivery-economic-snapshot": { revision: 1, sqlite: "84fc57e0fe9bdfc3b1a86877b73b075acbd77ed37f17342379114f4fe7b1f007", pg: "b63c8d22f66b6dbe5bf6cc349211b22ab63e4288ccc97f3597012087b60ce578" },
  "delivery-expense-entry": { revision: 1, sqlite: "c027e3d34eeeefc3b83f8f0ba15d991eacb9b44d81a7da183aa7c8a6d291a38e", pg: "bfea77170ae12dc0eb59c3b2e417121fd17a18560d0ae053b0791f1165e0a193" },
  "delivery-handover-run": { revision: 1, sqlite: "f868df8096eb8340979fb4086f05364aa6397da363e5ade1f1da7745e3b040e6", pg: "ef063e0d452186f3638d39fe63f7b6936ff51a8349440586f784d78158f1c5f0" },
  "delivery-milestone": { revision: 2, sqlite: "9b3e0926c64f69d988795273c13bc0755d10dee198f9b85900f9617b040d2c0c", pg: "821bd05be8b823e8d8cc9a50081a629d391016ad4f35f6ca05284af2f98401d5" },
  "delivery-partner-engagement": { revision: 1, sqlite: "11462df12729a488a127f980046562dd8e9097b465a93e6face46ddaadf3e007", pg: "283fcb6fb0303c9dd2e091a43ca842e2cdc1c82dab0e55423585714b4255aaca" },
  "delivery-plan-revision": { revision: 1, sqlite: "0487010891cb9b2b920bbc8f732e96f6e92b72e7a2e5ce10d7b325ec3e57a4dd", pg: "a46b43dd2ee2b8aacca2bdef65b07f5651c8fe1fbed7ef097f6631c5bbe7f5b0" },
  "delivery-project": { revision: 2, sqlite: "91589619dce4064cadcd74b75edd43630f4f12b13c72a3b32aad4f6e8d161a04", pg: "a8885f714f1317bed474bc5994f99d87d7446a3bc88f00abc931e764d60613dc" },
  "delivery-time-entry": { revision: 1, sqlite: "8a0c4d88a1c5caeb7fefae891a098b05f30883794136212bc6280852c487770e", pg: "5c229701ba7750a7c6e48ee307ec9c33a05ff49d525b58fcbee501804a09e3b0" },
  "delivery-work-package": { revision: 2, sqlite: "500f4c3a4677231effb8f470116b543463e092f16f7c48b8101accd80ce9aaf1", pg: "1d656b14e43ec72f0e8a4d17e43e817e7bf19cbc008ffa7c1b2147b1d603b7d8" },
  "call-notice": { revision: 1, sqlite: "7caa6903038811da3576e42f29f3299ec4666cb26dba9c4ebb8b6527f223ceac", pg: "c57a7657b8b0934443e778d84d4e8555f55b7c816dd82a5a5cd03b9adff2419c" },
  "call-signal": { revision: 1, sqlite: "1942c6b6c3977353f6361f469406b335690a14637be7559b949bd6b8eded2256", pg: "6728631f8360ca8890faaea8ed673deb983aadaa72a5a439122c779eab8439f9" },
  "call-transcript": { revision: 1, sqlite: "e19367a52c06e0eb8c52efe62a656f76af616e7c91b93b3c1ddb37586aa8d84b", pg: "862c2191d4660268ad7fb2c541df063ef4862c80e5769d3f5953731138a35834" },
  "assignment": { revision: 1, sqlite: "531f6bc8e97c347cce23147129ccca35f7f1d87151bd8c4d5f9b868bfefb8523", pg: "6b0868c24390545ead70207bed547cde76b06a153a44b4f822b9a431fc6f5727" },
  "behavioral-signal": { revision: 1, sqlite: "635c20c42932e63764cbd3feb0d15bc4c69ccba7276715bfb2833278627c9618", pg: "152caee077a180a4e1c56ea9ee46f2b021a348822d35902cc83671c79289bf37" },
  "enrichment-snapshot": { revision: 1, sqlite: "b123e23991ad21a8b884bc58c1c78f481b974a03db732e039781c61d9cc78bc4", pg: "9e09796a29a11f2027af5af54b8f82cf9c59824203b0ecf47d58cc62fb26a64c" },
  "route-evaluation": { revision: 1, sqlite: "12da1dcb2e85947e08cb44ece2a347ebeb6a4ecf909dc3a1c1071a8cb7343280", pg: "c5c1b60b0a5657425bc93e7556a90be0e560ebbeed4b36c0e5c1f34b5f62387c" },
  "routing-run": { revision: 1, sqlite: "265a03fdc822d17998e16339b561604156be8a37702f15dba443996e663c997e", pg: "b69a90e815c7f9b8f49eeebb5892ab1f4e3586e5cad2dbb9b84c4eb0cd7e2831" },
  "score-contribution": { revision: 1, sqlite: "e07d30a7cf3c4b873f471d5f4a0addc4073ecf3a32a1ad356e33bda3bd0dc2ca", pg: "231ee44727afb3529d452d5da38d4facb1fd944b2956d24cc34d9a654a0e2968" },
  "score-run": { revision: 1, sqlite: "dd4f8adbd1f0d0d85128ccf85de7338cb5cadf06655caf7532ede23044754af5", pg: "a75b616393b08dc70fe023ab09e2402eb42fbaabb041a76470c44f6328325ef5" },
  "conversation-assignment": { revision: 1, sqlite: "b2404b1f5231b5aca786c788955eba8b3232b4598f654e964da1b3513a0e9175", pg: "a396b73b28a4173972e54c03191156aaa0410b149440b882f4b4adcec4a41363" },
  "conversation-read": { revision: 1, sqlite: "d1f83e6fb75f76cb65f253ed54850e2c41a043840aa3e9092a45a2cf6e756d4c", pg: "987c91fcc082d3c4db22bbe056dc2ff82ccf0203e288563c166d682fbaf4ee4b" },
  "conversation-thread-key": { revision: 1, sqlite: "eb0601f63d90481aec295ad98607803b241a74c5268580403755500507884989", pg: "9ed7e3d9793a5f5f720674b67ce3b01f98b6e3bc6348e45f01c66ce9f4c6f7a6" },
  "conversation": { revision: 1, sqlite: "fef663901e73678f3a0bb11c84decae4f8d8238f94dbc845a549da78ed58961e", pg: "abbcf58ff1c83d683dc548c9c079e53760dd209d8f7d8952062541bd3ca397b1" },
  "interaction-call": { revision: 1, sqlite: "09ab499c89e528076043cedb573622a12eca054ab69463144ab590ebc3430bbe", pg: "bb0e0a13aa8edb432498c42992ddd9e7ca335c6311dd69d42708e24bc1fd4655" },
  "interaction-message": { revision: 1, sqlite: "123329094a1b91e8f45c8a0d03651ac0ea106ead4e9988b8fe05f9317b59d265", pg: "53bb73a80ee8b861029d139193dcc1c486b612f62828b51cab531895a9af2d4a" },
  "llm-call-audit": { revision: 1, sqlite: "55cdc5deace4f5b259e90b1cda84d258ca7e8ce7c9fb3f2943869bb387387e88", pg: "f1ca59b701e7e1e1969f7286e57bd0ebbd9d875cfb012ab12cdc1f4bc1fc14ae" },
  "llm-usage-day": { revision: 1, sqlite: "bbea39776e78ddc32c20f59bdba6f7c6588e5f712a24120857e35aae1a5db0af", pg: "aa51f81c105c995b5dcb00f835cd17852a9d9417c44dad256ef5bb58a20e91e1" },
  "amendment-run": { revision: 1, sqlite: "0cdf88006d152e134e3b4fc187ada471291d6e021a3f0294fd9a0032df07a125", pg: "02d96f8f9568dd57a6ff07aeef18884738980d90deac0bbf8c2e21b06a70fa28" },
  "commercial-followup": { revision: 1, sqlite: "683bff3136d6a2ac5f0513d4b4505c9fc92bbc134a90f6ef8ffb754da511e892", pg: "5d68c11bba042bb847eddc3d7126d8e14920994e7ccf48bab12bc1638dda5d46" },
  "renewal-decision": { revision: 1, sqlite: "bd4bb875f59c8f8aa331ee13506edb6d9c6df6d80b569ea4c4a9fa01f7f1afdb", pg: "1b5e76de9a93d2350b385454bb5fd2128848be08df071995bc5f1f89e11c78e6" },
  "campaign-proposal": { revision: 1, sqlite: "7950b56e4163e4f936f111db4eb4647951fbf62b42f805950208cabfc124dd61", pg: "1d9a36d83bce74f6698e5579bd62ab1986b1dff50208661277a14b1e792f6a46" },
  "campaign-version": { revision: 1, sqlite: "57d610d59c36bec4021da1f4532ef6d6a79ea4dc0e318ccb2afe1ed8cb8d9f51", pg: "e7a5927607fbc08c126517428bf611fdcf3fd3f39badf4413dd7b5cd6fd8614a" },
  "funnel-definition": { revision: 1, sqlite: "ef18034879c33c83c2a73cf5d9fcafe40c674f183454f81361aee754ded58f0b", pg: "393fb6218e83d1a4155fbd907e815a814cda0698fbb8007bba1474af0c2a8366" },
  "funnel-drop-insight": { revision: 1, sqlite: "fab8f803ff671fd40157aaae09876a1c2c1d469f1de49c9cef19845a98448f08", pg: "37f812f49296762d447ece1cec68b10b8df03e17a32074fe3b9fa3a68433f520" },
  "funnel-run": { revision: 1, sqlite: "71f839c129f09b6e6f3e89ece17c8bfb0017319780fe4fc79df9d800a50e4464", pg: "e4d5beabff061f1aca67d582ce5c05bc844a8db79bc7e6e0a9af500416c00dbb" },
  "payment-connection": { revision: 1, sqlite: "1d65099861a3076c2d165e27d7b1d2cc7322387d03c01a748637a9baa74d9cbd", pg: "6482a5d49cac7fc8499dd106244fefa636cc4de7b5fd1d4a4eba88dcaf4c1695" },
  "payment-event": { revision: 1, sqlite: "0f4255e58070be996a4fcf4cd82422f5265a4e32fa5e4145b1c7b912489e3aad", pg: "ca12f4407c1e2d7f096d2d49384b6b3c7d4b5542601a0a472bdcb10e36203bc4" },
  "payment-request": { revision: 1, sqlite: "2f708d76d8dcc67bad7925f0296b8a537887d7e1a18ffd493784de4307c0c81b", pg: "c06994557d4dbd39e1b3d76488a15eca7dcece763c67982ae77d3191ea3e46fe" },
  "service-activation-run": { revision: 1, sqlite: "2c2fb8df6c7113423c8f04df14c3146081e1674c692a935972d97aface170b03", pg: "3823c24d8180171890e604acc4213423d15797f937a57164da89cdb1be518635" },
  "service-coverage": { revision: 1, sqlite: "3df495604c1339eb5f8ec3d0d961b50caa4f3fb8ef563f071309003d51063655", pg: "44009d42aae97bfe397f37c7952c7021a9e9c19aef74063e28c89c30543aad71" },
  "service-entitlement": { revision: 1, sqlite: "a8e450adb111c70615f0295f328e79b795a6d51900e6f754fc2eb99a5fb44c24", pg: "7fb91533832058f6461fc345f6c874feae45022d8e42b5158c3adb0bf0dd7729" },
  "service-escalation": { revision: 1, sqlite: "18f8b75340d056c9babeb15321dc97e48a5908da25b5c78fca577c807ce48ed3", pg: "9409868562c6825d8fed816557a458d2a8415fc2a362b4761457dcab0313eaa8" },
  "service-sla-evaluation": { revision: 1, sqlite: "266c71fc3ca6f4e5e5b955dc6a58c50c7340c9caf65c3e75f21445b9083b25d5", pg: "fe0bd0f7aa6c4d5c4dc49f6dc49359aa9124d0c8cf58d6281ceab649edafa245" },
  "support-case-activity": { revision: 1, sqlite: "143447093e79bd041c51fcf2bcff8f33b8355b031fa9e8c2031b3ee9d33987e0", pg: "eb86d778d86c6f9f53b94553578359016cbf225ee073beeb3fbe9e407f8f3b56" },
  "support-case": { revision: 1, sqlite: "e8d8198a39ab0345bb4fd617e904f33f86c2f92374f32be887f7dee3a4986a90", pg: "073323fb6e54f1ac78d4c096b4524c0963a0badf85673c4e1a18206aecb13dca" },
  "order-component": { revision: 1, sqlite: "8f8dfcac4f6a8e65ac8dd36bdfaa54ed2f5806fdea83b9800f1a5d4e7785f465", pg: "ed3084f7ec7cd6a619a73525b07107e3fe994c545ae0e647cc75eb3f4b9edc61" },
  "order-line": { revision: 1, sqlite: "2b19ae821b035132af504c3ebea773b0a787edfb68d95eb8cd694636bf963b97", pg: "1ba1eb36667449ab92ae25aa10b1457f9b0463d11aa4465b9e2ba62269320430" },
  "order-term": { revision: 1, sqlite: "566e5d825eee926708b87bbd9b5fc9f30d287219864d89c4fc5226ff38cf98fe", pg: "1b61dc8cb26411eb9d4e43bcef3b0e10e50840fb73aa13a364f6c4b3b821f6d3" },
  "order-tier": { revision: 1, sqlite: "ad4e4c18cef8b12f43a49863d8dbafcf9b1e5e4db313f2c86e5295ed681145f7", pg: "24840ea742a21416ea1794173e0f6e941652cf101721a4b7ed8fcd4d451e5618" },
  "order-total": { revision: 1, sqlite: "75ea78c68a15bbd1dea4ed0e4a195eadd1a7f26ec983fc5fac48ef0dbbcc05ff", pg: "eeea76eb8b90695293eed9294b4a9f1218629f8ae405f2db1a708362bcb90435" },
  "order": { revision: 1, sqlite: "482588d7ffdca37d4e653900583d0309f697f44566c51fa6135d495e817db138", pg: "16047cd404727b165886f20fb7c1835e13384d2a5ae275df134c61bf345d8edb" },
  "sequence": { revision: 2, sqlite: "7adba1d3934939115ba81cb0013db65e00121c5d155449183cd4d0918196c1a1", pg: "6232ccfd4bc1afb1b96f74c47eed32b5112305c0dc76104d06199b10d6a42672" },
  "sequence-enrollment": { revision: 1, sqlite: "4dfd25d0c93ca746d8f0f9ea73bf3b9c2c3aafe9b7401792c96d49da94c9eb52", pg: "a4ff3fcd81bbb655c6523660c73f0eecac1eb3e5ed674ce5bc7caf8ec22127af" },
  "sequence-send": { revision: 2, sqlite: "7c4b1ea326859205b2e607271895c0d23243f1221de09edf6c34efcf717745f0", pg: "dda2b67accae58bcd442fdc191375d33a66b3dd7a6cc41cd5d4dfd7b9b8ffae0" },
  "sequence-step": { revision: 2, sqlite: "52be5a22b82f58b0b855c47610453d72eb0644d1f146faa1d47828ea061dc4a0", pg: "12e56eab9922f1f0a4106fd58304d5fb8983b842c8a012bbd1ffca7cd7655dca" },
  "signature-envelope": { revision: 1, sqlite: "84d400da668cae77625402587f9245fad5b8ac6b564dc034b10cfb2aa92907e9", pg: "f4e1259bbad33558d355ad222e8b7c0933beceac181bb483861ec22b07a119a4" },
  "signature-event": { revision: 1, sqlite: "5f5d56085ee6eec180b3edc21327ade5ac740f39a50bab1919392d4ed8f01b7c", pg: "24dd6e519d6d37806c6148f85c7ae3faf45bbeb5cae2f094957078dd767b115d" },
  "signature-signer": { revision: 1, sqlite: "1439411f7959944f71aa922fcd940eaa96155e9b7bb605b7a0357b1d80e16c6b", pg: "09ad61239484100d37ea3bdb223c3ca5c4092aaf5999c8ca960105d27095bbcf" },
  "signed-artifact": { revision: 1, sqlite: "c13f85fa2ef1e792e196184181e168e0ed0ccd469e7932d9e685e66e06bfe820", pg: "8cfde2256c59d0baa0293732b19be7d47215191cb084d5b82a99ef949e25116a" },
  "site-form-submission": { revision: 1, sqlite: "b0725086cd07dd68a327fa63166c2e22b41cb499851eb2c1b86411acc4fcbf10", pg: "cc48ccb770280394c9e9f073919966c0727d9cb68efeea448d5edd7d2bb5cbb8" },
  "space-ai-proposal": { revision: 1, sqlite: "d18e8ceb73e207974215fae3fcb5190e48b68dcca130f183e927cde6feef16d3", pg: "97887405896a53fd187b8e647fbecd09aaaae10bc39f51fed8c23e97baac8e0e" },
  "space-package": { revision: 1, sqlite: "386e216d5a4410b264a32f73b6fc61a642a850b00ed27563b12af710628415ef", pg: "814768de0269ccf4b0bfcf98e07b393e16b67846f0a7d754e315947061cda04b" },
  "space-permission-override": { revision: 1, sqlite: "162686fdf7779342733fcfe0e921e223f11ee22906f76bbc4411f4341745c45b", pg: "a34bf6b440900c52f149b72a36164fc6d280dbdc1e8b85ccf121d0466d453f41" },
  "work-activity": { revision: 2, sqlite: "42270f60cda19a00a619e349b9139484d6f7422dfb530806a253b6cb020d0fe2", pg: "105d69c5ce69c1f200ed4317d33112f5f3d3be9bc4bc79520100518e64279895" },
  "work-task": { revision: 1, sqlite: "42f2f15c58bfebce0e745d9090e23461202d0aba60df85446688f7a99b1085a3", pg: "3c3114ed031a0208c2c1abeb12026ef8502086923d88f87ef8d27bbc3e88c887" },
});

// The seven revision-2 modules that predate the history mechanism (accordo
// 61c450a2a1b1): declared born at revision 2 here — the kernel may not name
// them, so this guard holds the declaration and passes it to the contract
// check as `bornAtRevision`. Widening it is a visible test change, never a
// silent one.
const BORN_AT_REVISION_2 = Object.freeze({
  'commercial-contract': 2,
  'contract-activation': 2,
  'contract-version': 2,
  'service-obligation': 2,
  'delivery-milestone': 2,
  'delivery-project': 2,
  'delivery-work-package': 2,
});

function walkModuleManifests(directory) {
  const manifests = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    try {
      readdirSync(absolute);
      for (const nested of walkModuleManifests(absolute)) manifests.push(nested);
    } catch {
      if (name.endsWith('.module.json')) manifests.push(absolute);
    }
  }
  return manifests;
}

test('every manifest-selected module renders its recorded migration SQL at its recorded revision', () => {
  const files = walkModuleManifests(join(REPO_ROOT, 'packages'));
  assert.ok(files.length > 0, 'no *.module.json found under packages/');
  const seen = new Set();
  const failures = [];
  for (const absolute of files) {
    const relative = absolute.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch (error) {
      failures.push(`${relative}: cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    let normalized;
    try {
      normalized = validateModuleManifest(manifest);
    } catch (error) {
      failures.push(`${relative}: invalid manifest (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (seen.has(normalized.name)) {
      failures.push(`${relative}: duplicate module name "${normalized.name}"`);
      continue;
    }
    seen.add(normalized.name);
    const recorded = RECORDED[normalized.name];
    if (recorded === undefined) {
      failures.push(
        `${relative}: new module "${normalized.name}" — run \`npm run module:record -- ${relative}\` and paste its line into RECORDED in tests/module-manifest-revision-guard.test.js`,
      );
      continue;
    }
    const revision = manifestRevision(normalized);
    if (revision !== recorded.revision) {
      failures.push(
        `${relative}: revision ${revision} but RECORDED says ${recorded.revision} — `
        + 'when a revision ships, add its previous manifest to <name>.history.json, register it in '
        + 'packages/core/src/record-module-history.js, and update RECORDED in the same PR',
      );
      continue;
    }
    try {
      // The born-at declaration excuses exactly its revision; anything
      // undeclared stays fail-closed (bornAtRevision defaults to 1).
      assertRevisionHistoryContract(normalized.name, revision, {
        bornAtRevision: BORN_AT_REVISION_2[normalized.name] ?? 1,
      });
    } catch (error) {
      failures.push(
        `${relative}: revision ${revision} breaks the history contract — `
        + (error instanceof Error ? error.message : String(error)),
      );
      continue;
    }
    const sqlite = sha(generateModuleMigration(normalized).sql);
    const pg = sha(generatePostgresModuleBootstrap(normalized).sql);
    if (sqlite !== recorded.sqlite || pg !== recorded.pg) {
      failures.push(
        `${relative}: manifest SQL changed without raising revision (recorded revision ${recorded.revision}) — `
        + 'set "revision": ' + (recorded.revision + 1) + ', add the previous manifest to <name>.history.json, register it in '
        + 'packages/core/src/record-module-history.js, and update RECORDED in the same PR',
      );
    }
  }
  for (const name of Object.keys(RECORDED).sort()) {
    if (!seen.has(name)) {
      failures.push(`RECORDED module "${name}" has no *.module.json anymore — remove its entry`);
    }
  }
  assert.deepEqual(failures, [], `manifest migration drift:\n${failures.join('\n')}`);
});

test('the guard proves its own premise: changed SQL with the same revision fails', () => {
  // b8266ea in miniature: the recorded revision-2 data-quality-issue manifest
  // with one enum value added and the revision untouched must not match.
  const absolute = join(REPO_ROOT, 'packages/customer-data/modules/data-quality-issue.module.json');
  const manifest = JSON.parse(readFileSync(absolute, 'utf8'));
  const edited = JSON.parse(JSON.stringify(manifest));
  const kind = edited.fields.find((field) => field.name === 'kind');
  kind.values = [...kind.values, 'guard_probe_value'];
  const recorded = RECORDED['data-quality-issue'];
  assert.equal(manifestRevision(edited), recorded.revision);
  const drifted = sha(generatePostgresModuleBootstrap(edited).sql) !== recorded.pg
    || sha(generateModuleMigration(edited).sql) !== recorded.sqlite;
  assert.equal(drifted, true, 'the probe edit should change the rendered SQL');
});
test('a revision bump without history fails the history contract', () => {
  // The P2 hole from the #247 review: a bump that only updates RECORDED to
  // the new current-manifest SQL passes the SQL check, so the contract
  // itself must refuse — whoever raises revision ships the previous
  // manifest, or the guard fails.
  assert.throws(
    () => assertRevisionHistoryContract('guard-probe-module', 2),
    /at revision 2 without history/,
  );
  // Revision 1 needs nothing.
  assertRevisionHistoryContract('guard-probe-module', 1);
  // Modules with real history stay covered by it.
  assertRevisionHistoryContract('data-quality-issue', 2);
  assertRevisionHistoryContract('work-activity', 2);
  assertRevisionHistoryContract('calendar-sync-state', 2);
  // A covering history that is short for the revision fails too.
  assert.throws(
    () => assertRevisionHistoryContract('work-activity', 3),
    /ships 1 revision\(s\) of history; expected 2/,
  );
});

test('born-at-revision-2 modules are covered exactly at revision 2', () => {
  // Pinned: exactly these seven, each at exactly 2. Widening the declaration
  // is a visible test change, never a silent one.
  assert.deepEqual(Object.keys(BORN_AT_REVISION_2).sort(), [
    'commercial-contract',
    'contract-activation',
    'contract-version',
    'delivery-milestone',
    'delivery-project',
    'delivery-work-package',
    'service-obligation',
  ]);
  for (const name of Object.keys(BORN_AT_REVISION_2)) {
    assertRevisionHistoryContract(name, 2, { bornAtRevision: 2 });
  }
  // The declaration excuses nothing above: the next bump ships history.
  for (const name of Object.keys(BORN_AT_REVISION_2)) {
    assert.throws(
      () => assertRevisionHistoryContract(name, 3, { bornAtRevision: 2 }),
      new RegExp(`${name}".*at revision 3 without history`),
    );
  }
  // And without the declaration the same modules stay fail-closed.
  for (const name of Object.keys(BORN_AT_REVISION_2)) {
    assert.throws(
      () => assertRevisionHistoryContract(name, 2),
      new RegExp(`${name}".*at revision 2 without history`),
    );
  }
});
