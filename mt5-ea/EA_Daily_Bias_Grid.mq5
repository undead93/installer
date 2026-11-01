//+------------------------------------------------------------------+
//|                                          EA_Daily_Bias_Grid.mq5  |
//|  Teknik "Daily Bias" (harga buka + high/low semalam)             |
//|                                                                  |
//|   1. Tanda PDH (high semalam), PDL (low semalam) & harga buka    |
//|      hari (default pukul 9:00 pagi MYT)                          |
//|   2. Tentukan arah hari:                                         |
//|        BULLISH : harga atas PDH, ATAU PDL disapu & harga naik    |
//|                  balik ke dalam range                            |
//|        BEARISH : harga bawah PDL, ATAU PDH disapu & harga turun  |
//|                  balik ke dalam range                            |
//|        Tengah-tengah range (tiada sapuan) -> TIADA entry         |
//|   3. Sahkan dengan EMA 7/14/28 (kuning bawah = SELL, atas = BUY) |
//|   4. Tunggu harga patah balik melepasi harga buka:               |
//|        BULLISH -> BUY bila harga BAWAH harga buka                |
//|        BEARISH -> SELL bila harga ATAS harga buka                |
//|   0. Langkau hari jika candle semalam lemah (body < 200 pip &    |
//|      shadow panjang)                                             |
//|   5. SATU entry sehari. TP 20 pip. Layer setiap 20 pip,          |
//|      TP semua posisi = harga purata +/- 20 pip                   |
//+------------------------------------------------------------------+
#property copyright "Daily Bias Grid"
#property version   "3.00"
#property description "Daily bias (PDH/PDL + harga buka) + EMA 7/14/28 -> 1 entry sehari, TP 20 pip, layer 20 pip, average TP."

#include <Trade\Trade.mqh>

//--- enums
enum ENUM_GMT_MODE
  {
   GMT_AUTO   = 0, // Auto (live: kira sendiri | tester: GMT+2/+3 ikut DST US)
   GMT_MANUAL = 1  // Manual (guna nilai ServerGMTOffset)
  };

enum ENUM_RANGE_SRC
  {
   RANGE_BROKER_D1   = 0, // Candle D1 broker semalam (PDH/PDL standard)
   RANGE_SESSION_9AM = 1  // 24 jam sebelum mula hari (9AM semalam -> 9AM hari ini)
  };

enum ENUM_OPEN_SRC
  {
   OPEN_DAY_START_MYT = 0, // Harga masa mula hari (default 9:00 pagi MYT)
   OPEN_NY_MIDNIGHT   = 1  // Tengah malam New York (ICT asal, ~12PM/1PM MYT)
  };

enum ENUM_EMA_MODE
  {
   EMA_YELLOW_VS_BOTH = 0, // EMA7 atas/bawah EMA14 DAN EMA28
   EMA_FULL_STACK     = 1, // Susunan penuh (7>14>28 buy | 7<14<28 sell)
   EMA_YELLOW_VS_MID  = 2  // EMA7 atas/bawah EMA14 sahaja
  };

//--- inputs
input group "=== Hari Dagangan (Waktu Malaysia) ==="
input int           DayStartHourMYT   = 9;         // Hari baru bermula pukul (MYT)
input int           DayStartMinuteMYT = 0;         // Minit
input int           EntryWindowHours  = 24;        // Tempoh boleh entry selepas mula hari (jam, 1-24)
input ENUM_GMT_MODE GMTMode           = GMT_AUTO;  // Cara kira GMT offset broker
input int           ServerGMTOffset   = 2;         // GMT offset server broker (mode Manual)

input group "=== Daily Bias ==="
input ENUM_RANGE_SRC RangeSource      = RANGE_BROKER_D1;    // Sumber PDH / PDL
input ENUM_OPEN_SRC  OpenSource       = OPEN_DAY_START_MYT; // Sumber harga buka hari
input bool           UseSweepRule     = true;      // Kira sapuan PDH/PDL (rejection) sebagai bias
input bool           RequirePullback  = true;      // Tunggu harga lepas harga buka (beli murah / jual mahal)
input double         MinPullbackPips  = 0;         // Jarak minimum dari harga buka (pip)

input group "=== Tapis Candle Semalam ==="
input bool           UsePrevBodyFilter = true;     // Langkau hari jika candle semalam lemah
input double         MinPrevBodyPips   = 200;      // Body semalam minimum (pip)
input double         ShadowBodyRatio   = 1.0;      // Langkau hanya jika shadow >= X kali body (0 = abaikan shadow)

input group "=== EMA (Pengesahan) ==="
input bool            RequireEMA      = true;               // Wajib EMA sama arah
input ENUM_TIMEFRAMES EMA_TF          = PERIOD_H1;          // Timeframe EMA
input int             EMA_Fast        = 7;                  // EMA laju (kuning)
input int             EMA_Mid         = 14;                 // EMA sederhana (biru)
input int             EMA_Slow        = 28;                 // EMA perlahan (ungu)
input ENUM_EMA_MODE   EMA_Mode        = EMA_YELLOW_VS_BOTH; // Syarat EMA
input bool            UseClosedBar    = true;               // Guna candle yang dah tutup (elak repaint)

input group "=== Entry & Layer ==="
input double        LotSize           = 0.01;      // Lot permulaan
input double        LotMultiplier     = 1.0;       // Pengganda lot setiap layer (1.0 = lot sama)
input double        TPPips            = 20;        // TP (pip) dari harga purata
input double        LayerStepPips     = 20;        // Jarak layer (pip)
input int           MaxLayers         = 10;        // Maksimum layer (termasuk entry pertama)

input group "=== Risiko ==="
input double        MaxDrawdownPercent = 0;        // Cut loss basket jika floating rugi >= % balance (0 = off)
input double        MaxSpreadPips      = 0;        // Spread maksimum untuk entry pertama (0 = off)
input bool          SkipWeekendDay     = true;     // Tak entry untuk hari bermula Sabtu/Ahad

input group "=== Lain-lain ==="
input double        PipSizeOverride   = 0;         // Saiz 1 pip dalam harga (0 = auto)
input ulong         MagicNumber       = 808080;    // Magic number
input int           SlippagePoints    = 30;        // Slippage (points)
input string        TradeComment      = "BiasGrid";// Komen order
input bool          DrawLevels        = true;      // Lukis PDH / PDL / harga buka di chart

//--- globals
CTrade   trade;
int      hFast = INVALID_HANDLE, hMid = INVALID_HANDLE, hSlow = INVALID_HANDLE;
int      g_off      = 0;      // GMT offset server
datetime g_dayKey   = 0;      // masa mula hari dagangan (MYT)
bool     g_entered  = false;
bool     g_rangeOK  = false;
bool     g_openOK   = false;
double   g_pdh      = 0;
double   g_pdl      = 0;
double   g_pdo      = 0;      // open candle semalam
double   g_pdc      = 0;      // close candle semalam
double   g_open     = 0;
string   g_status   = "";

const string OBJ_PREFIX = "BIASG_";

struct Basket
  {
   int    count;
   int    dir;      // 1 buy, -1 sell
   double vol;
   double avg;
   double extreme;  // buy: harga entry paling rendah | sell: paling tinggi
   double profit;
  };

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
double Pip()
  {
   if(PipSizeOverride > 0)
      return PipSizeOverride;
   string s = _Symbol;
   StringToUpper(s);
   if(StringFind(s, "XAU") >= 0 || StringFind(s, "GOLD") >= 0)
      return 0.1;                     // emas: 1 pip = 0.10
   if(StringFind(s, "XAG") >= 0 || StringFind(s, "SILVER") >= 0)
      return 0.01;                    // perak: 1 pip = 0.01
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double pt  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(digits == 3 || digits == 5)
      return pt * 10.0;
   return pt;
  }

datetime NthSunday(int year, int month, int n)
  {
   MqlDateTime d;
   ZeroMemory(d);
   d.year = year;
   d.mon  = month;
   d.day  = 1;
   datetime t = StructToTime(d);
   TimeToStruct(t, d);
   int first = 1 + (7 - d.day_of_week) % 7;
   d.day  = first + 7 * (n - 1);
   d.hour = 0;
   d.min  = 0;
   d.sec  = 0;
   return StructToTime(d);
  }

bool IsUSDST(datetime t)
  {
   MqlDateTime d;
   TimeToStruct(t, d);
   datetime s = NthSunday(d.year, 3, 2);   // Ahad ke-2 Mac
   datetime e = NthSunday(d.year, 11, 1);  // Ahad pertama Nov
   return (t >= s && t < e);
  }

int ServerOffsetHours()
  {
   if(GMTMode == GMT_MANUAL)
      return ServerGMTOffset;
   if(!MQLInfoInteger(MQL_TESTER))
     {
      long diff = (long)(TimeTradeServer() - TimeGMT());
      return (int)MathRound(diff / 3600.0);
     }
   // Strategy Tester: anggap broker GMT+2 (musim sejuk) / GMT+3 (DST US)
   return IsUSDST(TimeCurrent()) ? 3 : 2;
  }

datetime MYTToServer(datetime myt) { return (datetime)((long)myt - (long)(8 - g_off) * 3600); }
datetime ServerToMYT(datetime srv) { return (datetime)((long)srv + (long)(8 - g_off) * 3600); }

datetime DayStartMYT(datetime myt)
  {
   MqlDateTime d;
   TimeToStruct(myt, d);
   d.hour = DayStartHourMYT;
   d.min  = DayStartMinuteMYT;
   d.sec  = 0;
   datetime r = StructToTime(d);
   if(myt < r)
      r -= 86400;
   return r;
  }

bool IsWeekendDay()
  {
   MqlDateTime d;
   TimeToStruct(g_dayKey, d);
   return (d.day_of_week == 0 || d.day_of_week == 6);
  }

double NormalizeLot(double lot)
  {
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double mn   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double mx   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      step = 0.01;
   lot = MathFloor(lot / step + 1e-9) * step;
   if(lot < mn)
      lot = mn;
   if(lot > mx)
      lot = mx;
   return NormalizeDouble(lot, 2);
  }

//--- index candle M1 pertama pada/selepas masa t (server). -1 jika belum ada
int FirstM1BarAtOrAfter(datetime t)
  {
   if(TimeCurrent() < t)
      return -1;
   int sh = iBarShift(_Symbol, PERIOD_M1, t, false);
   if(sh < 0)
      return -1;
   if(iTime(_Symbol, PERIOD_M1, sh) < t)
      sh--;
   return sh;
  }

//--- masa server bagi tengah malam New York pertama selepas mula hari
datetime NYMidnightServer()
  {
   long dayStartGMT = (long)g_dayKey - 8 * 3600;
   int  nyOff       = IsUSDST((datetime)dayStartGMT) ? -4 : -5;
   datetime nyLocal = (datetime)(dayStartGMT + (long)nyOff * 3600);
   MqlDateTime d;
   TimeToStruct(nyLocal, d);
   d.hour = 0;
   d.min  = 0;
   d.sec  = 0;
   datetime mid = StructToTime(d);
   if(mid < nyLocal)
      mid += 86400;
   long midGMT = (long)mid - (long)nyOff * 3600;
   return (datetime)(midGMT + (long)g_off * 3600);
  }

//+------------------------------------------------------------------+
//| Paras: PDH / PDL / harga buka                                    |
//+------------------------------------------------------------------+
void LoadRange()
  {
   if(RangeSource == RANGE_BROKER_D1)
     {
      double h = iHigh(_Symbol, PERIOD_D1, 1);
      double l = iLow(_Symbol, PERIOD_D1, 1);
      double o = iOpen(_Symbol, PERIOD_D1, 1);
      double c = iClose(_Symbol, PERIOD_D1, 1);
      if(h <= 0 || l <= 0 || o <= 0 || c <= 0)
         return;
      g_pdh = h;
      g_pdl = l;
      g_pdo = o;
      g_pdc = c;
     }
   else
     {
      datetime startSrv = MYTToServer(g_dayKey);
      datetime prevSrv  = (datetime)((long)startSrv - 86400);
      int shStart = FirstM1BarAtOrAfter(prevSrv);
      int shEnd   = FirstM1BarAtOrAfter(startSrv);
      if(shStart < 0)
         return;
      // candle terakhir sebelum mula hari
      shEnd = (shEnd < 0) ? 0 : shEnd + 1;
      int count = shStart - shEnd + 1;
      if(count < 1)
         return;
      int hi = iHighest(_Symbol, PERIOD_M1, MODE_HIGH, count, shEnd);
      int lo = iLowest(_Symbol, PERIOD_M1, MODE_LOW, count, shEnd);
      if(hi < 0 || lo < 0)
         return;
      g_pdh = iHigh(_Symbol, PERIOD_M1, hi);
      g_pdl = iLow(_Symbol, PERIOD_M1, lo);
      g_pdo = iOpen(_Symbol, PERIOD_M1, shStart);
      g_pdc = iClose(_Symbol, PERIOD_M1, shEnd);
     }
   g_rangeOK = true;
   PrintFormat("PDH = %s | PDL = %s | Body semalam %.0f pip, shadow %.0f pip",
               DoubleToString(g_pdh, _Digits), DoubleToString(g_pdl, _Digits), PrevBodyPips(), PrevShadowPips());
   DrawLevelsNow();
  }

void LoadOpen()
  {
   datetime t = (OpenSource == OPEN_NY_MIDNIGHT) ? NYMidnightServer() : MYTToServer(g_dayKey);
   int sh = FirstM1BarAtOrAfter(t);
   if(sh < 0)
      return;
   double p = iOpen(_Symbol, PERIOD_M1, sh);
   if(p <= 0)
      return;
   g_open   = p;
   g_openOK = true;
   PrintFormat("Harga buka hari = %s (%s MYT)", DoubleToString(g_open, _Digits),
               TimeToString(ServerToMYT(iTime(_Symbol, PERIOD_M1, sh)), TIME_DATE | TIME_MINUTES));
   DrawLevelsNow();
  }

//--- saiz body & jumlah shadow (atas + bawah) candle semalam, dalam pip
double PrevBodyPips()   { return MathAbs(g_pdc - g_pdo) / Pip(); }
double PrevShadowPips() { return ((g_pdh - g_pdl) - MathAbs(g_pdc - g_pdo)) / Pip(); }

//--- true = candle semalam lemah (body kecil, shadow panjang) -> langkau hari ini
bool PrevDayWeak()
  {
   if(!UsePrevBodyFilter || !g_rangeOK)
      return false;
   double body = PrevBodyPips();
   if(body >= MinPrevBodyPips)
      return false;
   if(ShadowBodyRatio <= 0)
      return true;
   return (PrevShadowPips() >= body * ShadowBodyRatio);
  }

//--- high / low "hari ini" untuk semak sapuan PDH/PDL
bool TodayHighLow(double &hi, double &lo)
  {
   if(RangeSource == RANGE_BROKER_D1)
     {
      hi = iHigh(_Symbol, PERIOD_D1, 0);
      lo = iLow(_Symbol, PERIOD_D1, 0);
      return (hi > 0 && lo > 0);
     }
   int sh = FirstM1BarAtOrAfter(MYTToServer(g_dayKey));
   if(sh < 0)
      return false;
   int h = iHighest(_Symbol, PERIOD_M1, MODE_HIGH, sh + 1, 0);
   int l = iLowest(_Symbol, PERIOD_M1, MODE_LOW, sh + 1, 0);
   if(h < 0 || l < 0)
      return false;
   hi = iHigh(_Symbol, PERIOD_M1, h);
   lo = iLow(_Symbol, PERIOD_M1, l);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   hi = MathMax(hi, bid);
   lo = MathMin(lo, bid);
   return true;
  }

//+------------------------------------------------------------------+
//| Bias hari: 1 bullish, -1 bearish, 0 tiada                        |
//+------------------------------------------------------------------+
int GetBias(string &why)
  {
   why = "";
   if(!g_rangeOK)
      return 0;
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   if(bid > g_pdh)
     {
      why = "harga atas PDH";
      return 1;
     }
   if(bid < g_pdl)
     {
      why = "harga bawah PDL";
      return -1;
     }

   if(UseSweepRule)
     {
      double hi, lo;
      if(TodayHighLow(hi, lo))
        {
         bool sweptH = (hi > g_pdh);
         bool sweptL = (lo < g_pdl);
         if(sweptL && !sweptH)
           {
            why = "PDL disapu & harga naik balik";
            return 1;
           }
         if(sweptH && !sweptL)
           {
            why = "PDH disapu & harga turun balik";
            return -1;
           }
         if(sweptH && sweptL)
           {
            why = "PDH & PDL dua-dua disapu (tiada arah)";
            return 0;
           }
        }
     }
   why = "harga dalam range semalam";
   return 0;
  }

//+------------------------------------------------------------------+
//| EMA signal: 1 buy, -1 sell, 0 tiada                              |
//+------------------------------------------------------------------+
int EMASignal(double &f, double &m, double &s)
  {
   int sh = UseClosedBar ? 1 : 0;
   double bf[1], bm[1], bs[1];
   if(CopyBuffer(hFast, 0, sh, 1, bf) != 1)
      return 0;
   if(CopyBuffer(hMid, 0, sh, 1, bm) != 1)
      return 0;
   if(CopyBuffer(hSlow, 0, sh, 1, bs) != 1)
      return 0;
   f = bf[0];
   m = bm[0];
   s = bs[0];

   switch(EMA_Mode)
     {
      case EMA_FULL_STACK:
         if(f > m && m > s)
            return 1;
         if(f < m && m < s)
            return -1;
         break;
      case EMA_YELLOW_VS_MID:
         if(f > m)
            return 1;
         if(f < m)
            return -1;
         break;
      default: // EMA_YELLOW_VS_BOTH
         if(f > m && f > s)
            return 1;
         if(f < m && f < s)
            return -1;
         break;
     }
   return 0;
  }

//+------------------------------------------------------------------+
//| Basket                                                           |
//+------------------------------------------------------------------+
void GetBasket(Basket &b)
  {
   b.count   = 0;
   b.dir     = 0;
   b.vol     = 0;
   b.avg     = 0;
   b.extreme = 0;
   b.profit  = 0;
   double sumPV = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)MagicNumber)
         continue;

      int    dir   = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 1 : -1;
      double price = PositionGetDouble(POSITION_PRICE_OPEN);
      double vol   = PositionGetDouble(POSITION_VOLUME);

      if(b.count == 0)
        {
         b.dir     = dir;
         b.extreme = price;
        }
      b.count++;
      b.vol    += vol;
      sumPV    += price * vol;
      b.profit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);

      if(dir > 0 && price < b.extreme)
         b.extreme = price;
      if(dir < 0 && price > b.extreme)
         b.extreme = price;
     }
   if(b.vol > 0)
      b.avg = sumPV / b.vol;
  }

double BasketTP(const Basket &b)
  {
   double tp = (b.dir > 0) ? b.avg + TPPips * Pip() : b.avg - TPPips * Pip();
   return NormalizeDouble(tp, _Digits);
  }

void SetBasketTP(double tp)
  {
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)MagicNumber)
         continue;

      double curTP = PositionGetDouble(POSITION_TP);
      if(MathAbs(curTP - tp) < _Point / 2.0)
         continue;

      bool isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      if(isBuy && tp - bid <= minDist)
         continue;   // terlalu dekat, TP maya (virtual) akan tutup
      if(!isBuy && ask - tp <= minDist)
         continue;

      double sl = PositionGetDouble(POSITION_SL);
      if(!trade.PositionModify(tk, sl, tp))
         PrintFormat("Gagal ubah TP #%I64u: %d %s", tk, trade.ResultRetcode(), trade.ResultRetcodeDescription());
     }
  }

void CloseAll(string reason)
  {
   PrintFormat("Tutup semua posisi: %s", reason);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)MagicNumber)
         continue;
      if(!trade.PositionClose(tk, SlippagePoints))
         PrintFormat("Gagal tutup #%I64u: %d %s", tk, trade.ResultRetcode(), trade.ResultRetcodeDescription());
     }
  }

bool OpenLayer(int dir, int layer)
  {
   double lot = NormalizeLot(LotSize * MathPow(LotMultiplier, layer - 1));
   string cm  = StringFormat("%s L%02d", TradeComment, layer);
   double pip = Pip();
   bool ok;

   if(dir > 0)
     {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double tp  = (layer == 1) ? NormalizeDouble(ask + TPPips * pip, _Digits) : 0;
      ok = trade.Buy(lot, _Symbol, ask, 0, tp, cm);
     }
   else
     {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double tp  = (layer == 1) ? NormalizeDouble(bid - TPPips * pip, _Digits) : 0;
      ok = trade.Sell(lot, _Symbol, bid, 0, tp, cm);
     }

   uint rc = trade.ResultRetcode();
   if(!ok || (rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_PLACED))
     {
      PrintFormat("Gagal buka %s layer %d: %d %s", dir > 0 ? "BUY" : "SELL", layer, rc, trade.ResultRetcodeDescription());
      return false;
     }
   PrintFormat("Buka %s layer %d lot %.2f", dir > 0 ? "BUY" : "SELL", layer, lot);
   return true;
  }

void ManageBasket()
  {
   Basket b;
   GetBasket(b);
   if(b.count == 0)
      return;

   // Cut loss ikut % balance
   if(MaxDrawdownPercent > 0 &&
      b.profit <= -AccountInfoDouble(ACCOUNT_BALANCE) * MaxDrawdownPercent / 100.0)
     {
      CloseAll("Max drawdown dicapai");
      return;
     }

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double tp  = BasketTP(b);

   // TP maya - kalau harga dah lepas TP purata, tutup semua
   if((b.dir > 0 && bid >= tp) || (b.dir < 0 && ask <= tp))
     {
      CloseAll("TP purata dicapai");
      return;
     }

   // Layer setiap X pip lawan arah
   if(b.count < MaxLayers)
     {
      double step = LayerStepPips * Pip();
      bool needLayer = (b.dir > 0 && ask <= b.extreme - step) ||
                       (b.dir < 0 && bid >= b.extreme + step);
      if(needLayer && OpenLayer(b.dir, b.count + 1))
        {
         GetBasket(b);
         tp = BasketTP(b);
        }
     }

   SetBasketTP(tp);
  }

//+------------------------------------------------------------------+
//| Dah entry hari ini? (semak history - selamat bila restart)       |
//+------------------------------------------------------------------+
bool EnteredToday()
  {
   if(g_entered)
      return true;
   datetime from = MYTToServer(g_dayKey);
   if(!HistorySelect(from, TimeCurrent() + 3600))
      return false;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0)
         continue;
      if(HistoryDealGetString(d, DEAL_SYMBOL) != _Symbol)
         continue;
      if(HistoryDealGetInteger(d, DEAL_MAGIC) != (long)MagicNumber)
         continue;
      if(HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_IN)
         continue;
      if(StringFind(HistoryDealGetString(d, DEAL_COMMENT), " L01") < 0)
         continue;
      g_entered = true;
      return true;
     }
   return false;
  }

void TryEntry()
  {
   if(SkipWeekendDay && IsWeekendDay())
     {
      g_status = "Hari hujung minggu - tiada entry";
      return;
     }
   if(EnteredToday())
     {
      g_status = "Dah entry hari ini - tunggu esok";
      return;
     }
   datetime myt = ServerToMYT(TimeCurrent());
   if(EntryWindowHours < 24 && (long)myt - (long)g_dayKey >= (long)EntryWindowHours * 3600)
     {
      g_status = "Luar waktu entry - tunggu esok";
      return;
     }
   if(!g_rangeOK)
     {
      g_status = "Menunggu data PDH/PDL";
      return;
     }
   if(PrevDayWeak())
     {
      g_status = StringFormat("Candle semalam lemah (body %.0f pip, shadow %.0f pip) - tiada entry hari ini",
                              PrevBodyPips(), PrevShadowPips());
      return;
     }
   if(RequirePullback && !g_openOK)
     {
      g_status = "Menunggu harga buka hari";
      return;
     }
   if(MaxSpreadPips > 0)
     {
      double spr = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / Pip();
      if(spr > MaxSpreadPips)
        {
         g_status = StringFormat("Spread tinggi (%.1f pip) - tunggu", spr);
         return;
        }
     }

   string why;
   int bias = GetBias(why);
   if(bias == 0)
     {
      g_status = "Tiada arah (" + why + ") - tiada entry";
      return;
     }

   string bName = (bias > 0) ? "BULLISH" : "BEARISH";

   if(RequireEMA)
     {
      double f, m, s;
      if(EMASignal(f, m, s) != bias)
        {
         g_status = bName + " - tunggu EMA kuning sama arah";
         return;
        }
     }

   if(RequirePullback)
     {
      double bid  = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double need = MinPullbackPips * Pip();
      bool ok = (bias > 0) ? (bid <= g_open - need) : (bid >= g_open + need);
      if(!ok)
        {
         g_status = bName + (bias > 0 ? " - tunggu harga turun bawah harga buka"
                                      : " - tunggu harga naik atas harga buka");
         return;
        }
     }

   if(OpenLayer(bias, 1))
     {
      g_entered = true;
      PrintFormat("Entry %s | %s | PDH %s PDL %s Buka %s", bias > 0 ? "BUY" : "SELL", why,
                  DoubleToString(g_pdh, _Digits), DoubleToString(g_pdl, _Digits), DoubleToString(g_open, _Digits));
     }
  }

//+------------------------------------------------------------------+
//| Paparan                                                          |
//+------------------------------------------------------------------+
void DrawHLine(string name, double price, color clr, ENUM_LINE_STYLE style, string label)
  {
   string n = OBJ_PREFIX + name;
   if(ObjectFind(0, n) < 0)
      ObjectCreate(0, n, OBJ_HLINE, 0, 0, price);
   ObjectSetDouble(0, n, OBJPROP_PRICE, price);
   ObjectSetInteger(0, n, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, n, OBJPROP_STYLE, style);
   ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, n, OBJPROP_BACK, true);
   ObjectSetString(0, n, OBJPROP_TEXT, label);
   ObjectSetString(0, n, OBJPROP_TOOLTIP, label);
  }

void DrawLevelsNow()
  {
   if(!DrawLevels)
      return;
   if(g_rangeOK)
     {
      DrawHLine("PDH", g_pdh, clrLimeGreen, STYLE_DASH, "PDH");
      DrawHLine("PDL", g_pdl, clrTomato, STYLE_DASH, "PDL");
     }
   if(g_openOK)
      DrawHLine("OPEN", g_open, clrGold, STYLE_SOLID, "Harga buka");
   ChartRedraw();
  }

void Dashboard()
  {
   double f = 0, m = 0, s = 0;
   int sig = EMASignal(f, m, s);
   string why;
   int bias = GetBias(why);
   Basket b;
   GetBasket(b);

   string txt = "=== Daily Bias Grid ===\n";
   txt += StringFormat("Masa MYT : %s  (server GMT%+d)\n",
                       TimeToString(ServerToMYT(TimeCurrent()), TIME_DATE | TIME_MINUTES), g_off);
   txt += StringFormat("Hari     : bermula %s MYT\n", TimeToString(g_dayKey, TIME_DATE | TIME_MINUTES));
   txt += StringFormat("PDH      : %s\n", g_rangeOK ? DoubleToString(g_pdh, _Digits) : "-");
   txt += StringFormat("PDL      : %s\n", g_rangeOK ? DoubleToString(g_pdl, _Digits) : "-");
   if(g_rangeOK)
      txt += StringFormat("Semalam  : body %.0f pip | shadow %.0f pip -> %s\n", PrevBodyPips(), PrevShadowPips(),
                          PrevDayWeak() ? "LEMAH (langkau hari ini)" : "OK");
   txt += StringFormat("Buka     : %s\n", g_openOK ? DoubleToString(g_open, _Digits) : "menunggu...");
   txt += StringFormat("Bias     : %s (%s)\n", bias > 0 ? "BULLISH" : (bias < 0 ? "BEARISH" : "TIADA"), why);
   txt += StringFormat("EMA%d/%d/%d : %s / %s / %s -> %s\n", EMA_Fast, EMA_Mid, EMA_Slow,
                       DoubleToString(f, _Digits), DoubleToString(m, _Digits), DoubleToString(s, _Digits),
                       sig > 0 ? "BUY" : (sig < 0 ? "SELL" : "tiada"));

   if(b.count > 0)
      txt += StringFormat("Basket   : %s x%d  lot %.2f  avg %s  TP %s  P/L %.2f\n",
                          b.dir > 0 ? "BUY" : "SELL", b.count, b.vol,
                          DoubleToString(b.avg, _Digits), DoubleToString(BasketTP(b), _Digits), b.profit);
   else
      txt += "Basket   : tiada\n";

   txt += "Status   : " + g_status;
   Comment(txt);
  }

//+------------------------------------------------------------------+
//| Event handlers                                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   if(DayStartHourMYT < 0 || DayStartHourMYT > 23 || DayStartMinuteMYT < 0 || DayStartMinuteMYT > 59)
     {
      Print("Jam/minit mula hari tidak sah");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(TPPips <= 0 || LayerStepPips <= 0 || LotSize <= 0 || MaxLayers < 1 ||
      EntryWindowHours < 1 || EntryWindowHours > 24 || MinPullbackPips < 0)
     {
      Print("Input tidak sah");
      return INIT_PARAMETERS_INCORRECT;
     }

   hFast = iMA(_Symbol, EMA_TF, EMA_Fast, 0, MODE_EMA, PRICE_CLOSE);
   hMid  = iMA(_Symbol, EMA_TF, EMA_Mid,  0, MODE_EMA, PRICE_CLOSE);
   hSlow = iMA(_Symbol, EMA_TF, EMA_Slow, 0, MODE_EMA, PRICE_CLOSE);
   if(hFast == INVALID_HANDLE || hMid == INVALID_HANDLE || hSlow == INVALID_HANDLE)
     {
      Print("Gagal cipta handle EMA");
      return INIT_FAILED;
     }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   g_dayKey = 0;
   PrintFormat("EA dimulakan. 1 pip = %s", DoubleToString(Pip(), _Digits));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   if(hFast != INVALID_HANDLE)
      IndicatorRelease(hFast);
   if(hMid != INVALID_HANDLE)
      IndicatorRelease(hMid);
   if(hSlow != INVALID_HANDLE)
      IndicatorRelease(hSlow);
   ObjectsDeleteAll(0, OBJ_PREFIX);
   Comment("");
  }

void OnTick()
  {
   g_off = ServerOffsetHours();
   datetime myt = ServerToMYT(TimeCurrent());
   datetime day = DayStartMYT(myt);

   // Hari baru (setiap 9AM MYT)
   if(day != g_dayKey)
     {
      g_dayKey  = day;
      g_entered = false;
      g_rangeOK = false;
      g_openOK  = false;
      g_status  = "";
     }

   if(!g_rangeOK)
      LoadRange();
   if(!g_openOK)
      LoadOpen();

   // Urus basket sedia ada (TP purata + layer)
   ManageBasket();

   Basket b;
   GetBasket(b);
   if(b.count > 0)
      g_status = "Basket aktif - urus layer & TP purata";
   else
      TryEntry();

   Dashboard();
  }
//+------------------------------------------------------------------+
