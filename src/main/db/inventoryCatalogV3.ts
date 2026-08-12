import type { Database } from 'better-sqlite3'
import { createHash } from 'crypto'
import { nowIso } from '../util'
import { isMatchableSku } from '@shared/identifiers'
import { boxesPerCaseFromName } from '@shared/units'
import { brandOf, unitTypeOf, yearOf } from './inventorySeed'

/**
 * Catalog import v3 — the products RM carries, taken from the owner's own list.
 *
 * `[name, sku, category]` exactly as supplied. UPC and picture are deliberately
 * absent: the list did not carry them, and a guessed barcode is worse than none
 * (a wrong one makes the scanner pull up the wrong product). Everything
 * financial — cost, high bid, sale price, reorder point — stays blank for a
 * supervisor to fill in, the same as the v2 expansion did.
 *
 * THE ONE RULE THIS FILE OBEYS: it only ever INSERTs. There is no UPDATE and no
 * DELETE anywhere below, which is what makes "don't touch any of the current
 * inventory" a property of the code rather than a promise about it. A product
 * already in the catalog — by name or by a real SKU — is skipped whole, keeping
 * its stock, its cost basis, its images and its edits.
 */
const CATALOG_V3: Array<[string, string, string]> = [
  ['2026 Topps Chrome Baseball Jumbo Hobby 8-Box Case', '6626', 'Baseball'],
  ['2026 Panini Prizm FIFA World Cup Soccer Hobby Box', 'BOX', 'Soccer'],
  ['2020-21 Panini Prizm Basketball Hobby Box', 'BOX', 'Basketball'],
  ['2026 Panini Prizm FIFA World Cup Soccer Hobby 12-Box Case', '19426', 'Soccer'],
  ['2026 Topps Chrome VeeFriends Hobby Box', 'BOX', 'Entertainment'],
  ['Pokemon Scarlet & Violet Destined Rivals Sleeved Booster Case', '100-10623', 'Pokemon'],
  ['2026 Topps Chrome Baseball Hobby 12-Box Case', '6625', 'Baseball'],
  ['2025 Topps Stadium Club UFC Hobby Box', 'BOX', 'Combat'],
  ["2025 Bowman Draft Baseball Breaker's Delight 6-Box Case", '6463', 'Baseball'],
  ['2026 Topps Finest Baseball Hobby 8-Box Case', '6619', 'Baseball'],
  ['2025 Bowman Draft Baseball Hobby 8-Box Case', '6461', 'Baseball'],
  ['2025 Topps Resurgence Football Delight 6-Box Case', '6837', 'Football'],
  ['2025 Panini National Treasures Football Hobby 4-Box Case', '18948', 'Football'],
  ['2025 Topps Chrome Baseball Delight 6-Box Case', '6246', 'Baseball'],
  ['2025 Topps Chrome Football Hobby 12-Box Case', '6390', 'Football'],
  ['2025 Topps Cosmic Chrome Football Hobby 8-Box Case', '6835', 'Football'],
  ['2025 Topps Finest Football Hobby 8-Box Case', '6827', 'Football'],
  ['2024-25 Upper Deck The Cup Hockey Hobby 3-Box Case', '18759', 'Hockey'],
  ['2026 Topps Finest Baseball Delight 6-Box Case', '7220', 'Baseball'],
  ['2025 Bowman Draft Baseball Super Jumbo 6-Box Case', '6462', 'Baseball'],
  ['2025 Panini Prizm Football Hobby 12-Box Case', '18725', 'Football'],
  ['2025 Topps Chrome Football Hobby Box', 'BOX', 'Football'],
  ['2025 Topps Chrome Football Hobby Jumbo 8-Box Case', '6392', 'Football'],
  ['2025 Topps Signature Class Football Hobby Jumbo 6-Box Case', '7221', 'Football'],
  ['2025-26 Bowman Basketball Delight 6-Box Case', '6682', 'Basketball'],
  ['2025-26 Topps Chrome Cactus Jack Basketball Hobby 12-Box Case', '7231', 'Basketball'],
  ['2026 Bowman Baseball Hobby Jumbo 8-Box Case', '6579', 'Baseball'],
  ['2026 Topps Tier One Baseball Hobby 12-Box Case', '6576', 'Baseball'],
  ['2025 Topps Chrome Football Delight 6-Box Case', '6393', 'Football'],
  ["2025 Bowman's Best Baseball Hobby 8-Box Case", '6531', 'Baseball'],
  ['2025 Panini Donruss Optic Football Hobby 12-Box Case', '18816', 'Football'],
  ['2025 Topps Gilded Collection Baseball Hobby 4-Box Case', '6291', 'Baseball'],
  ['2025 Topps Pristine Baseball Hobby 6-Box Case', '6155', 'Baseball'],
  ['2025-26 Topps Signature Class Basketball Hobby 12-Box Case', '6675', 'Basketball'],
  ['2026 Topps Chrome Black Baseball Hobby 12-Box Case', '6560', 'Baseball'],
  ['2026 Topps Disney Chrome Hobby 8-Box Case', '6782', 'Entertainment'],
  ['2025-26 Panini Select Road to FIFA World Cup Soccer Hobby 12-Box Case', '19837', 'Soccer'],
  ['2024 Panini National Treasures Football Hobby 4-Box Case', '17332', 'Football'],
  ['2025 Panini Impeccable Football Hobby 3-Box Case', '18603', 'Football'],
  ['2024-25 Panini Noir Basketball Hobby 4-Box Case', '18810', 'Basketball'],
  ['2025 Panini Absolute Football Hobby 12-Box Case', '18646', 'Football'],
  ['2025-26 Panini Donruss Road to FIFA World Cup Soccer Hobby 12-Box Case', '17867', 'Soccer'],
  ['2025-26 Bowman Basketball Hobby 12-Box Case', '6684', 'Basketball'],
  ['2025-26 Bowman Basketball Hobby Jumbo 8-Box Case', '6685', 'Basketball'],
  ['2026 Topps Chrome Baseball Delight 6-Box Case', '6623', 'Baseball'],
  ['2020-21 Panini Prizm Basketball Hobby 12-Box Case', '95978', 'Basketball'],
  ['2021-22 Upper Deck The Cup Hockey Hobby 3-Box Case', '98430', 'Hockey'],
  ['2022-23 Upper Deck The Cup Hockey Hobby 3-Box Case', '14073', 'Hockey'],
  ['2022-23 Upper Deck The Cup Hockey Hobby 6-Box Case', '14069', 'Hockey'],
  ['2023-24 Panini Phoenix Basketball Hobby 16-Box Case', '15847', 'Basketball'],
  ['2023-24 Topps Royalty Basketball Hobby 4-Box Case', '5590', 'Basketball'],
  ['2023-24 Upper Deck Black Diamond Hockey Hobby 10-Box Case', '16380', 'Hockey'],
  ['2023-24 Upper Deck Skybox Metal Universe Hockey Hobby 16-Box Case', '47633', 'Hockey'],
  ['2023-24 Upper Deck Ultimate Collection Hockey Hobby 16-Box Case', '51717', 'Hockey'],
  ['2024 Panini Contenders Football Hobby 12-Box Case', '16987', 'Football'],
  ['2024 Panini Encore Football Hobby 12-Box Case', '17316', 'Football'],
  ['2024 Panini Flawless Football Hobby 2-Box Case', '17336', 'Football'],
  ['2024 Panini Immaculate Football Hobby 6-Box Case', '16872', 'Football'],
  ['2024-2025 Marvel Studios Chrome Sapphire Edition Hobby 10-Box Case', '7191', 'Entertainment'],
  ['2024-25 Panini Donruss Optic Basketball Hobby 12-Box Case', '17981', 'Basketball'],
  ['2024-25 Panini Eminence Basketball Hobby Case', '17933', 'Basketball'],
  ['2024-25 Panini Immaculate Soccer Hobby 6-Box Case', '17823', 'Soccer'],
  ['2024-25 Panini Obsidian Soccer Hobby 12-Box Case', '17787', 'Soccer'],
  ['2024-25 Panini Prizm Basketball Hobby 12-Box Case', '16416', 'Basketball'],
  ['2024-25 Panini Prizm Deca Basketball Hobby 10-Box Case', '17864', 'Basketball'],
  ['2024-25 Panini Revolution Basketball Blaster 20-Box Case', '17857', 'Basketball'],
  ['2024-25 Panini Select Basketball Hobby 12-Box Case', '18049', 'Basketball'],
  ['2024-25 Panini Select Basketball Hobby International 12-Box Case', '18058', 'Basketball'],
  ["2024-25 Topps Chrome UEFA Women's Champions League Soccer Hobby 12-Box Case", '6229', 'Soccer'],
  ['2024-25 Topps Definitive UEFA Club Competitions Soccer Hobby 3-Box Case', '6235', 'Soccer'],
  ['2024-25 Topps UEFA Club Competitions Chrome Soccer Hanger 64-Box Case', '6123', 'Soccer'],
  ['2024-25 Topps UEFA Club Competitions Merlin Chrome Soccer Blaster 40-Box Case', '6238', 'Soccer'],
  ['2024-25 Topps UEFA Club Competitions Museum Collection Soccer Hobby 8-Box Case', '6103', 'Soccer'],
  ['2024-25 Upper Deck Engrained Icons Hockey Hobby 10-Box Case', '03495', 'Hockey'],
  ['2024-25 Upper Deck Ice Hockey Hobby 12-Box Case', '78687', 'Hockey'],
  ['2024-25 Upper Deck Ice Hockey Hobby 24-Box Case', '78685', 'Hockey'],
  ['2024-25 Upper Deck O-Pee-Chee Platinum Hockey Hobby 8-Box Case', '82545', 'Hockey'],
  ['2024-25 Upper Deck Premier Hockey Hobby 10-Box Case', '18848', 'Hockey'],
  ['2024-25 Upper Deck Stature Hockey Hobby 16-Box Case', '82777', 'Hockey'],
  ['2025 Bowman Chrome Baseball Hobby 12-Box Case', '6382', 'Baseball'],
  ["2025 Bowman Chrome University Football Breaker's Delight 10-Box Case", '6374', 'Football'],
  ['2025 Bowman Draft Baseball Hobby Box', 'BOX', 'Baseball'],
  ['2025 Bowman Draft Baseball Mega 20-Box Case', '6460', 'Baseball'],
  ['2025 Bowman Draft Baseball Sapphire Edition 10-Box Case', '6464', 'Baseball'],
  ['2025 Bowman Draft Baseball Super Jumbo Box', 'BOX', 'Baseball'],
  ['2025 Bowman University Chrome Football Blaster 40-Box Case', '6376', 'Football'],
  ['2025 Bowman University Chrome Football Hobby 12-Box Case', '6372', 'Football'],
  ['2025 Bowman University Chrome Football Hobby Jumbo 8-Box Case', '6373', 'Football'],
  ['2025 Panini Absolute Football Hobby Blaster 20-Box Case', '18685', 'Football'],
  ['2025 Panini Authentically Mahomes Football Hobby Case', '19475', 'Football'],
  ['2025 Panini Black Football Hobby 12-Box Case', '18598', 'Football'],
  ['2025 Panini Donruss Baseball Hobby Blaster 20-Box Case', '18185', 'Baseball'],
  ['2025 Panini Donruss Optic Football 6-Pack Hobby Blaster 20-Box Case', '18852', 'Football'],
  ['2025 Panini Donruss Optic Football Hobby Mega 20-Box Case', '18855', 'Football'],
  ['2025 Panini Flawless Baseball Hobby 2-Box Case', '18261', 'Baseball'],
  ['2025 Panini Flawless Football Hobby 2-Box Case', '18953', 'Football'],
  ['2025 Panini Immaculate Football Hobby 6-Box Case', '18811', 'Football'],
  ['2025 Panini Impeccable Baseball Hobby 3-Box Case', '18200', 'Baseball'],
  ['2025 Panini Mosaic Football No Huddle 20-Box Case', '18616', 'Football'],
  ['2025 Panini Mosaic Football No Huddle Box', 'BOX', 'Football'],
  ['2025 Panini National Treasures Baseball Hobby 4-Box Case', '18233', 'Baseball'],
  ['2025 Panini National Treasures Racing Hobby 4-Box Case', '18298', 'Racing'],
  ['2025 Panini Prizm Black Football Hobby 12-Box Case', '19712', 'Football'],
  ['2025 Panini Prizm Football 1st Off The Line FOTL Hobby 12-Box Case', '18727', 'Football'],
  ['2025 Panini Prizm Football Choice 20-Box Case', '18740', 'Football'],
  ['2025 Panini Prizm Football Choice Box', 'BOX', 'Football'],
  ['2025 Panini Prizm Football Hobby Blaster 20-Box Case', '18776', 'Football'],
  ['2025 Panini Prizm Football Hobby Box', 'BOX', 'Football'],
  ['2025 Panini Prizm Football Mega Hobby 20-Box Case', '18779', 'Football'],
  ['2025 Panini Prizm Football No Huddle 20-Box Case', '18732', 'Football'],
  ['2025 Panini Prizm Racing Hobby Blaster 20-Box Case', '18314', 'Racing'],
  ['2025 Panini Prizm WNBA Basketball Hobby 12-Box Case', '19032', 'Basketball'],
  ['2025 Panini Prospect Edition Baseball Blaster 20-Box Case', '18271', 'Baseball'],
  ['2025 Panini Prospect Edition Baseball Hobby 20-Box Case', '18266', 'Baseball'],
  ['2025 Panini Rookies & Stars Football 48-Pack Gravity Feed 6-Box Case', '18790', 'Football'],
  ['2025 Panini Rookies & Stars Football Hobby 14-Box Case', '18782', 'Football'],
  ['2025 Panini Rookies & Stars Football Hobby Blaster 20-Box Case', '18787', 'Football'],
  ['2025 Panini Select Baseball Hobby Blaster 20-Box Case', '18258', 'Baseball'],
  ['2025 Panini Select Football Hobby 12-Box Case', '18861', 'Football'],
  ['2025 Panini Select Football Hobby Blaster 20-Box Case', '18902', 'Football'],
  ['2025 Panini Select Football Hobby Mega 20-Box Case', '18905', 'Football'],
  ['2025 Panini Select WNBA Basketball Hobby 12-Box Case', '19059', 'Basketball'],
  ['2025 Panini Select WNBA Basketball Hobby Blaster 20-Box Case', '19071', 'Basketball'],
  ['2025 Panini Select WNBA Basketball Hobby Mega 20-Box Case', '19332', 'Basketball'],
  ['2025 Panini Silhouette Football Hobby 10-Box Case', '19717', 'Football'],
  ['2025 Topps Allen & Ginter Baseball Blaster 40-Box Case', '6332', 'Baseball'],
  ['2025 Topps Allen & Ginter Baseball Fat Pack 108-Pack Case', '6335', 'Baseball'],
  ['2025 Topps Archives Baseball Blaster 40-Box Case', '6289', 'Baseball'],
  ['2025 Topps Chrome Baseball Blaster 40-Box Case', '6247', 'Baseball'],
  ['2025 Topps Chrome Baseball Hobby 12-Box Case', '6244', 'Baseball'],
  ['2025 Topps Chrome Black Baseball Hobby 12-Box Case', '6042', 'Baseball'],
  ['2025 Topps Chrome Black Football Hobby 12-Box Case', '6836', 'Football'],
  ['2025 Topps Chrome Black Football Hobby Box', 'BOX', 'Football'],
  ['2025 Topps Chrome Deadpool Hobby 12-Box Case', '6433', 'Racing'],
  ['2025 Topps Chrome F1 Formula 1 Hobby 12-Box Case', '6349', 'Racing'],
  ['2025 Topps Chrome Football Blaster 40-Box Case', '6395', 'Football'],
  ['2025 Topps Chrome Football Hanger 64-Box Case', '6401', 'Football'],
  ['2025 Topps Chrome Football Mega 20-Box Case', '6398', 'Football'],
  ['2025 Topps Chrome Football Sapphire Edition 10-Box Case', '6394', 'Football'],
  ['2025 Topps Chrome Formula 1 F1 Racing Sapphire Edition 10-Box Case', '6350', 'Racing'],
  ['2025 Topps Chrome Formula 1 Racing Blaster 40-Box Case', '6351', 'Racing'],
  ['2025 Topps Chrome Labubu 10th Anniversary 20-Box Case', 'n/a', 'Entertainment'],
  ['2025 Topps Chrome MLS Soccer Hobby 12-Box Case', '6437', 'Soccer'],
  ['2025 Topps Chrome MLS Soccer Mania 5-Box Case', '6439', 'Soccer'],
  ['2025 Topps Chrome Platinum Baseball Blaster 40-Box Case', '6179', 'Baseball'],
  ['2025 Topps Chrome Platinum Baseball Hobby 12-Box Case', '6178', 'Baseball'],
  ["2025 Topps Chrome Tennis Breaker's Delight 12-Box Case", '6337', 'Tennis'],
  ['2025 Topps Chrome Tennis Hobby 12-Box Case', '6336', 'Tennis'],
  ['2025 Topps Chrome UFC Sapphire Edition 10-Box Case', '6091', 'Combat'],
  ['2025 Topps Chrome Update Series Baseball Blaster 40-Box Case', '6367', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Delight 6-Box Case', '6365', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Hobby 12-Box Case', '6363', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Jumbo Hobby 8-Box Case', '6364', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Mega 20-Box Case', '6369', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Sapphire Edition 10-Box Case', '6366', 'Baseball'],
  ['2025 Topps Cosmic Chrome Baseball Hobby 8-Box Case', '6280', 'Baseball'],
  ['2025 Topps Cosmic Chrome Football Hobby Box', 'BOX', 'Football'],
  ['2025 Topps Crystal 30 Years of Toy Story Hobby 12-Box Case', '6762', 'Entertainment'],
  ['2025 Topps Deadpool Chrome Blaster 40-Box Case', '6434', 'Entertainment'],
  ['2025 Topps Definitive Baseball Hobby 2-Box Case', '6482', 'Baseball'],
  ['2025 Topps Disney Wonder Blaster 40-Box Case', '6415', 'Entertainment'],
  ['2025 Topps Disney Wonder Hobby 12-Box Case', '6414', 'Entertainment'],
  ['2025 Topps Disneyland 70th Anniversary Blaster 40-Box Case', '6760', 'Entertainment'],
  ['2025 Topps Disneyland 70th Anniversary Hobby 12-Box Case', '6759', 'Entertainment'],
  ['2025 Topps Dynasty Baseball Hobby 5-Box Case', '6484', 'Baseball'],
  ['2025 Topps Dynasty UEFA Club Competitions Soccer Hobby 5-Box Case', '6347', 'Soccer'],
  ['2025 Topps Finest Baseball Hobby 8-Box Case', '6260', 'Baseball'],
  ['2025 Topps Finest Baseball Hobby Box', 'BOX', 'Baseball'],
  ['2025 Topps Finest Football Delight 8-Box Case', '6826', 'Football'],
  ['2025 Topps Five Star Baseball Hobby 3-Box Case', '6282', 'Baseball'],
  ['2025 Topps Holiday Baseball Mega 20-Box Case', '6284', 'Baseball'],
  ['2025 Topps Inception Baseball Hobby 8-Box Case', '6483', 'Baseball'],
  ['2025 Topps Inception Baseball Hobby Box', 'BOX', 'Baseball'],
  ['2025 Topps Marvel Studios Chrome Hobby 8-Box Case', '6444', 'Entertainment'],
  ['2025 Topps Marvel The Collector Hobby 4-Box Case', '6134', 'Entertainment'],
  ['2025 Topps MLS Chrome Sapphire Edition 10-Box Case', '6438', 'Soccer'],
  ['2025 Topps Museum Collection Baseball Hobby 8-Box Case', '6273', 'Baseball'],
  ['2025 Topps Pixar Gold Hobby 6-Box Case', '6355', 'Entertainment'],
  ['2025 Topps Royalty UFC Hobby 4-Box Case', '6486', 'Combat'],
  ['2025 Topps Royalty WWE Wrestling Hobby 4-Box Case', '6143', 'Combat'],
  ['2025 Topps Signature Class Football Blaster 40-Box Case', '6834', 'Football'],
  ['2025 Topps Signature Class Football Hobby 12-Box Case', '6828', 'Football'],
  ['2025 Topps Signature Class Football Mega 20-Box Case', '6831', 'Football'],
  ['2025 Topps Stadium Club Baseball Blaster 40-Box Case', '6408', 'Baseball'],
  ['2025 Topps Stadium Club Baseball Blaster Box', 'BOX', 'Baseball'],
  ['2025 Topps Stadium Club Baseball Hobby 16-Box Case', '6407', 'Baseball'],
  ['2025 Topps Stadium Club Baseball Mega 20-Box Case', '6410', 'Baseball'],
  ['2025 Topps Stadium Club UFC Blaster 40-Box Case', '6340', 'Combat'],
  ['2025 Topps Stadium Club UFC Hobby 16-Box Case', '6339', 'Combat'],
  ['2025 Topps Stadium Club UFC Mega 20-Box Case', '6342', 'Combat'],
  ['2025 Topps Star Wars Chrome Delight 10-Box Case', '6065', 'Entertainment'],
  ['2025 Topps Star Wars Chrome Hobby 8-Box Case', '6064', 'Entertainment'],
  ['2025 Topps Star Wars Hyperspace Hobby 8-Box Case', '6223', 'Entertainment'],
  ['2025 Topps Star Wars Masterwork Hobby 8-Box Case', '6487', 'Entertainment'],
  ['2025 Topps Star Wars Smugglers Outpost Hobby 6-Box Case', '6142', 'Entertainment'],
  ['2025 Topps Transcendent Collection Baseball Hobby Case', '6292', 'Baseball'],
  ['2025 Topps WWE Chrome Blaster 40-Box Case', '6083', 'Combat'],
  ['2025 Upper Deck Fleer Ultra Superman Hobby 12-Box Case', '4422', 'Entertainment'],
  ['2025-26 Bowman Basketball Blaster 40-Box Case', '6692', 'Basketball'],
  ['2025-26 Bowman Basketball Mega 20-Box Case', '6688', 'Basketball'],
  ['2025-26 Bowman Basketball Sapphire Edition 10-Box Case', '6689', 'Basketball'],
  ['2025-26 Bowman University Best Basketball Hobby 12-Box Case', '6743', 'Basketball'],
  ['2025-26 Panini Donruss Basketball Hobby 16-Box Case', '18995', 'Basketball'],
  ['2025-26 Panini Donruss Road to FIFA World Cup Soccer Hobby Blaster 20-Box Case', '17882', 'Soccer'],
  ['2025-26 Panini Noir Road to FIFA World Cup Soccer Hobby 3-Box Case', '17835', 'Soccer'],
  ['2025-26 Panini Prizm FIFA Soccer Choice 20-Box Case', '17891', 'Soccer'],
  ['2025-26 Panini Prizm FIFA Soccer Hobby 12-Box Case', '17885', 'Soccer'],
  ['2025-26 Panini Select EuroLeague Basketball Hobby 12-Box Case', '19545', 'Basketball'],
  ['2025-26 Panini Select La Liga Soccer Hobby 12-Box Case', '19336', 'Soccer'],
  ['2025-26 Panini Select Ligue 1 Soccer H2 12-Box Case', '19360', 'Soccer'],
  ['2025-26 Panini Select Serie A Soccer Hobby 12-Box Case', '19348', 'Soccer'],
  ['2025-26 Panini Signature Series Basketball Hobby 12-Box Case', '18974', 'Basketball'],
  ['2025-26 Panini Signature Series Basketball Hobby Box', 'BOX', 'Basketball'],
  ['2025-26 Topps Basketball Hobby Box', 'BOX', 'Basketball'],
  ['2025-26 Topps Chrome Basketball Breaker Delight 6-Box Case', '6368', 'Basketball'],
  ['2025-26 Topps Chrome Basketball Delight 6-Box Case', '6468', 'Basketball'],
  ['2025-26 Topps Chrome Basketball Hobby 12-Box Case', '6465', 'Basketball'],
  ['2025-26 Topps Chrome Basketball Hobby Jumbo 8-Box Case', '6467', 'Basketball'],
  ['2025-26 Topps Chrome Cactus Jack Basketball Hobby Box', 'BOX', 'Basketball'],
  ['2025-26 Topps Chrome Cactus Jack Basketball x NBA All-Star Game Box', 'BOX', 'Basketball'],
  ['2025-26 Topps Chrome UEFA Club Competitions Soccer Blaster 40-Box Case', '7052', 'Soccer'],
  ['2025-26 Topps Chrome UEFA Club Competitions Soccer Delight 6-Box Case', '7036', 'Soccer'],
  ['2025-26 Topps Chrome UEFA Club Competitions Soccer First Day Issue Hobby 12-Box Case', '7037', 'Soccer'],
  ['2025-26 Topps Chrome UEFA Club Competitions Soccer Hobby 12-Box Case', '7042', 'Soccer'],
  ['2025-26 Topps Chrome UEFA Club Competitions Soccer Hobby Jumbo 8-Box Case', '7044', 'Soccer'],
  ['2025-26 Topps Chrome UEFA Club Competitions Soccer Mega 20-Box Case', '7048', 'Soccer'],
  ["2025-26 Topps Chrome UEFA Women's Champions League Soccer Hobby 12-Box Case", '7069', 'Soccer'],
  ['2025-26 Topps Cosmic Chrome Basketball Hobby 8-Box Case', '6673', 'Basketball'],
  ['2025-26 Topps Finest Basketball Hobby 8-Box Case', '6671', 'Basketball'],
  ['2025-26 Topps Holiday Basketball Mega 20-Box Case', '6666', 'Basketball'],
  ['2025-26 Topps Hoops Basketball Blaster 40-Box Case', '6702', 'Basketball'],
  ['2025-26 Topps Hoops Basketball Hobby 12-Box Case', '6698', 'Basketball'],
  ['2025-26 Topps Hoops Basketball Hobby Jumbo 8-Box Case', '6699', 'Basketball'],
  ['2025-26 Topps Inception Basketball Hobby 8-Box Case', '6705', 'Basketball'],
  ['2025-26 Topps Merlin English Premier League Soccer Blaster 40-Box Case', '6495', 'Soccer'],
  ['2025-26 Topps Merlin English Premier League Soccer Hobby 12-Box Case', '6492', 'Soccer'],
  ['2025-26 Topps Midnight Basketball Hobby 8-Box Case', '6488', 'Basketball'],
  ['2025-26 Topps Signature Class Basketball Blaster 40-Box Case', '6681', 'Basketball'],
  ['2025-26 Topps Signature Class Basketball Hobby Jumbo 6-Box Case', '7228', 'Basketball'],
  ['2025-26 Topps Signature Class Basketball Mega 20-Box Case', '6678', 'Basketball'],
  ['2025-26 Topps Three Basketball Hobby 4-Box Case', '6668', 'Basketball'],
  ['2025-26 Topps UEFA Club Competitions Finest Soccer Hobby 8-Box Case', '7059', 'Soccer'],
  ['2025-26 Topps UEFA Club Competitions Soccer Blaster 40-Box Case', '7015', 'Soccer'],
  ['2025-26 Topps UEFA Club Competitions Soccer Hobby 12 Box Case', '7012', 'Soccer'],
  ['2025-26 Upper Deck Flair Hockey Hobby 10-Box Case', '8141', 'Hockey'],
  ['2025-26 Upper Deck Flair Hockey Hobby Box', 'BOX', 'Hockey'],
  ['2025-26 Upper Deck O-Pee-Chee Platinum Hockey Hobby 8-Box Case', '46040', 'Hockey'],
  ['2026 Bowman Baseball Blaster 40-Box Case', '6586', 'Baseball'],
  ["2026 Bowman Baseball Breaker's Delight 6-Box Case", '6577', 'Baseball'],
  ['2026 Bowman Baseball Hobby 12-Box Case', '6578', 'Baseball'],
  ['2026 Bowman Baseball Sapphire Edition Hobby 10-Box Case', '6583', 'Baseball'],
  ['2026 Panini Donruss Elite Baseball Hobby 12-Box Case', '20319', 'Baseball'],
  ['2026 Panini Donruss Racing Hobby 20-Box Case', '19580', 'Racing'],
  ['2026 Panini Immaculate Baseball Hobby 6-Box Case', '19876', 'Baseball'],
  ['2026 Panini Prizm FIFA World Cup Soccer Choice 20-Box Case', '19431', 'Soccer'],
  ['2026 Panini Select Racing Hobby 12-Box Case', '19597', 'Racing'],
  ['2026 Panini USA Stars And Stripes Prizm Baseball Hobby 12 Box Case', '19614', 'Baseball'],
  ['2026 Topps Chrome Baseball Blaster 40-Box Case', '6634', 'Baseball'],
  ['2026 Topps Chrome Marvel Comics Blaster 40-Box Case', '6778', 'Entertainment'],
  ['2026 Topps Chrome Marvel Comics Hobby 8-Box Case', '6774', 'Entertainment'],
  ['2026 Topps Chrome Premier League EPL Soccer 7-Pack Blaster 40-Box Case', '6263', 'Soccer'],
  ['2026 Topps Chrome Premier League EPL Soccer Breakers Delight 6-Box Case', 'FS6260', 'Soccer'],
  ['2026 Topps Chrome Premier League EPL Soccer Hobby 12-Box Case', '6259', 'Soccer'],
  ['2026 Topps Chrome UFC Blaster 40-Box Case', '7136', 'Combat'],
  ['2026 Topps Chrome UFC Blaster Box', 'BOX', 'Combat'],
  ['2026 Topps Chrome UFC Delight 8-Box Case', '7128', 'Combat'],
  ['2026 Topps Chrome UFC Hobby 12-Box Case', '7129', 'Combat'],
  ['2026 Topps Chrome UFC Hobby Box', 'BOX', 'Combat'],
  ['2026 Topps Chrome UFC Mega 20-Box Case', '7132', 'Combat'],
  ['2026 Topps Chrome UFC Mega Box', 'BOX', 'Combat'],
  ['2026 Topps Chrome UFC Sapphire Edition 10-Box Case', '7133', 'Combat'],
  ['2026 Topps Chrome VeeFriends Hobby 12-Box Case', '7195', 'Entertainment'],
  ['2026 Topps Chrome WWE Wrestling Blaster 40-Box Case', '7159', 'Combat'],
  ['2026 Topps Chrome WWE Wrestling Delight 6-Box Case', '7150', 'Combat'],
  ['2026 Topps Chrome WWE Wrestling Hobby 12-Box Case', '7151', 'Combat'],
  ['2026 Topps Chrome WWE Wrestling Hobby Box', 'BOX', 'Combat'],
  ['2026 Topps Chrome WWE Wrestling Sapphire Edition 10-Box Case', '7156', 'Combat'],
  ['2026 Topps Cosmic Chrome WWE Wrestling Hobby 8-Box Case', '7160', 'Combat'],
  ['2026 Topps Disney Chrome Blaster 40-Box Case', '6789', 'Entertainment'],
  ['2026 Topps Disney Neon Blaster 40-Box Case', '6770', 'Entertainment'],
  ['2026 Topps Disney Neon Hobby 12-Box Case', '7243', 'Entertainment'],
  ['2026 Topps Disney Neon Mega 20-Box Case', '6767', 'Entertainment'],
  ['2026 Topps Finest Baseball Hobby Box', 'BOX', 'Baseball'],
  ['2026 Topps Finest Baseball Mega 20-Box Case', '7610', 'Baseball'],
  ['2026 Topps Finest English Premier League Soccer Hobby 8-Box Case', '6415', 'Soccer'],
  ['2026 Topps Finest Marvel Fantastic Four 65th Anniversary Hobby 8-Box Case', '6772', 'Entertainment'],
  ['2026 Topps Heritage Baseball Blaster 40-Box Case', '6573', 'Baseball'],
  ['2026 Topps Heritage Baseball Hobby 12-Box Case', '6567', 'Baseball'],
  ['2026 Topps Knockout UFC Hobby 8-Box Case', '7138', 'Combat'],
  ['2026 Topps Midnight UFC Hobby 8-Box Case', '7137', 'Combat'],
  ['2026 Topps Series 1 Baseball 36-Tin Case', '6553', 'Baseball'],
  ['2026 Topps Series 1 Baseball Blaster 40-Box Case', '6556', 'Baseball'],
  ['2026 Topps Series 1 Baseball Fat Pack 108-Pack Case', '6539', 'Baseball'],
  ['2026 Topps Series 1 Baseball Hobby 12-Box Case', '6544', 'Baseball'],
  ['2026 Topps Series 1 Baseball Hobby Jumbo 6-Box Case', '6545', 'Baseball'],
  ['2026 Topps Series 1 Baseball Mega 20-Box Case', '6549', 'Baseball'],
  ['2026 Topps Series 2 Baseball Blaster 40-Box Case', '6608', 'Baseball'],
  ['2026 Topps Series 2 Baseball Hobby 12-Box Case', '6599', 'Baseball'],
  ['2026 Topps Series 2 Baseball Hobby Jumbo 6-Box Case', '6600', 'Baseball'],
  ['2026 Topps Series 2 Baseball Hobby Jumbo Box', 'BOX', 'Baseball'],
  ['2026 Topps Series 2 Baseball Mega 20-Box Case', '6603', 'Baseball'],
  ['2026 Topps Tier One Baseball Hobby Box', 'BOX', 'Baseball'],
  ['2026 Topps Tribute Baseball Hobby 4-Box Case', '6558', 'Baseball'],
  ['2026 Topps VeeFriends Chrome Blaster 40-Box Case', '7196', 'Entertainment'],
  ['2026 Topps VeeFriends Chrome Mega 20-Box Case', '7449', 'Entertainment'],
  ['Carrying On His Will Booster Case', '83353', 'Entertainment']
]

/**
 * Categories the owner's list uses that the app files elsewhere.
 *
 * `Combat` is the old name for what the app renamed to `UFC` back in v0.0.3 —
 * and all 24 rows under it are UFC or WWE. The rename was a one-time migration
 * that has already run on every machine, so a row inserted as `Combat` today
 * would sit outside the category list forever. Mapped on the way in instead.
 */
const CATEGORY_ALIASES: Record<string, string> = { Combat: 'UFC' }

/**
 * Is this SKU a real identifier, i.e. worth matching an existing product on?
 *
 * The rule — `BOX` and its friends identify nothing, and neither does anything
 * under three characters — moved to @shared/identifiers when the dashboard grew
 * a "Missing identifiers" view, because that screen has to agree with this
 * importer about what counts as a SKU or it reports 27 rows sharing the word BOX
 * as fully identified. Re-exported rather than re-implemented: two copies of
 * this predicate are two things that must change together forever, and the
 * cost-of-drift here is an import that silently swallows a product.
 */
export { isMatchableSku }

/**
 * The key two product names are compared on. Case, punctuation and spacing all
 * vary between how a name was typed here and how it was typed into the catalog
 * months ago — "12-Box Case" / "12 Box Case", "Bowman's" / "Bowmans" — and each
 * of those differences would otherwise insert a second copy of a product that
 * is already there.
 */
export function catalogNameKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * A stable id for a catalog row, the same on every machine.
 *
 * This seed runs locally on each install — before the sync capture triggers are
 * installed — so the same product would otherwise be created under a different
 * random id on the shop laptop than on the owner's. The first time anyone edited
 * one, sync would carry that machine's id across and the other machine would end
 * up holding two of the same product. Deriving the id from the name instead
 * means every machine independently arrives at the same row.
 *
 * Shaped as a UUID because that is what every other product id in the database
 * looks like; the bytes are a SHA-1 of a namespace plus the name key (the same
 * construction as a RFC 4122 v5 UUID).
 */
export function catalogProductId(name: string): string {
  const h = createHash('sha1').update('rmops:catalog:v3:' + catalogNameKey(name)).digest()
  const b = Buffer.from(h.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface CatalogImportResult {
  /** Rows in the supplied list. */
  considered: number
  inserted: number
  /** Already in the catalog under the same (normalized) name. */
  skippedByName: number
  /** Already in the catalog under the same real SKU, under a different name. */
  skippedBySku: number
}

/**
 * Add every product from the list that the catalog does not already hold.
 *
 * Match order is name first, then SKU: a name is what a person recognises and
 * what the rest of the app matches on, and a SKU is the tiebreak for the same
 * product typed two different ways.
 *
 * The two rules have deliberately different reach. The NAME is this list's
 * identity, so it is checked against the catalog and against what this run has
 * already inserted — the list cannot duplicate against itself. The SKU is only
 * ever checked against the catalog as it stood before the run, because a SKU
 * repeated inside the list means one of the two was typed wrong, not that they
 * are the same product. (The list does this once: 6415 sits on both the Disney
 * Wonder blaster case and the Finest Premier League case.) Widening the SKU rule
 * to cover the run would silently drop the second of the pair.
 */
export function seedCatalogV3(database: Database): CatalogImportResult {
  return seedCatalogRows(database, CATALOG_V3)
}

/**
 * The insert-only import, over any list of [name, sku, category] rows.
 *
 * Split out of `seedCatalogV3` when a second list arrived: the rules below are
 * the load-bearing part and having two copies of them is how a later list
 * quietly acquires different behaviour from the first.
 */
export function seedCatalogRows(
  database: Database,
  rows: ReadonlyArray<readonly [string, string, string]>
): CatalogImportResult {
  const ts = nowIso()
  const existing = database
    .prepare('SELECT id, name, sku FROM inventory_products')
    .all() as Array<{ id: string; name: string; sku: string | null }>

  const names = new Set<string>()
  const skus = new Set<string>()
  for (const p of existing) {
    const key = catalogNameKey(p.name)
    if (key) names.add(key)
    const sku = (p.sku || '').trim().toUpperCase()
    if (isMatchableSku(sku)) skus.add(sku)
  }

  const insert = database.prepare(
    `INSERT INTO inventory_products
       (id, sku, upc, upc_norm, name, category, brand, set_name, year, unit_type,
        boxes_per_case, packs_per_box, giveaway_item, unit_cost, high_bid,
        sale_price, reorder_point, notes, created_at, updated_at)
     VALUES
       (@id, @sku, NULL, NULL, @name, @category, @brand, '', @year, @unit_type,
        @boxes_per_case, NULL, 0, 0, NULL, NULL, 0, NULL, @ts, @ts)`
  )

  const idTaken = database.prepare('SELECT 1 AS one FROM inventory_products WHERE id = ?')

  const result: CatalogImportResult = {
    considered: rows.length,
    inserted: 0,
    skippedByName: 0,
    skippedBySku: 0
  }

  const run = database.transaction(() => {
    for (const [name, sku, rawCategory] of rows) {
      const key = catalogNameKey(name)
      if (!key) continue
      if (names.has(key)) {
        result.skippedByName++
        continue
      }
      const skuKey = sku.trim().toUpperCase()
      const matchable = isMatchableSku(skuKey)
      if (matchable && skus.has(skuKey)) {
        result.skippedBySku++
        continue
      }

      const id = catalogProductId(name)
      // Belt and braces: a deterministic id that somehow already exists means
      // this row is already here under a name that normalized differently.
      // Skipping beats an INSERT that would abort the whole transaction.
      const taken = idTaken.get(id) as { one: number } | undefined
      if (taken) {
        result.skippedByName++
        continue
      }

      insert.run({
        id,
        sku,
        name,
        category: CATEGORY_ALIASES[rawCategory] ?? rawCategory,
        brand: brandOf(name),
        year: yearOf(name),
        unit_type: unitTypeOf(name),
        // Only a case has boxes in it; the contract returns null for a box, a
        // tin case and a pack case alike, which is the honest answer for all
        // three. packs_per_box is never guessed — see the v25 note in database.ts.
        boxes_per_case: boxesPerCaseFromName(name),
        ts
      })
      names.add(key)
      result.inserted++
    }
  })
  run()
  return result
}
