//+------------------------------------------------------------------+
//|                                      EA_Daily_Momentum_Grid.mq5  |
//|  Logik:                                                          |
//|   1. Sehari SATU entry sahaja (hari bermula 9:00 pagi MYT)       |
//|   2. Kaji momentum: buy atau sell yang lebih kuat                |
//|      (banding jumlah badan candle naik vs candle turun)          |
//|   3. Sahkan dengan EMA 7 / 14 / 28:                              |
//|        EMA7 (kuning) di BAWAH  -> SELL                           |
//|        EMA7 (kuning) di ATAS   -> BUY                            |
//|      Entry hanya bila momentum DAN EMA sama arah                 |
//|   4. TP 20 pip                                                   |
//|   5. Kalau harga lawan arah, layer setiap 20 pip                 |
//|      TP semua posisi = harga purata (average) +/- 20 pip         |
//+------------------------------------------------------------------+
#property copyright "Daily Momentum Grid"
#property version   "2.00"
#property description "1 entry sehari ikut momentum paling kuat + EMA 7/14/28 -> TP 20 pip, layer 20 pip, average TP."

#include <Trade\Trade.mqh>

//--- enums
enum ENUM_GMT_MODE
  {
   GMT_AUTO   = 0, // Auto (live: kira sendiri | tester: GMT+2/+3 ikut DST US)
   GMT_MANUAL = 1  // Manual (guna nilai ServerGMTOffset)
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

input group "=== Momentum ==="
input ENUM_TIMEFRAMES MomTF           = PERIOD_H1; // Timeframe kaji momentum
input int             MomBars         = 24;        // Bilangan candle dikaji (24 x H1 = 1 hari)
input double          MinStrengthPct  = 20;        // Kekuatan minimum % (beza buy% - sell%)
input double          MinNetMovePips  = 0;         // Gerakan bersih minimum dalam tempoh (pip, 0 = off)
input bool            UseADX          = false;     // Tapis guna ADX (trend kuat)
input int             ADXPeriod       = 14;        // Period ADX
input double          ADXMin          = 25;        // ADX minimum

input group "=== EMA (Rujukan Arah) ==="
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
input ulong         MagicNumber       = 707070;    // Magic number
input int           SlippagePoints    = 30;        // Slippage (points)
input string        TradeComment      = "MomGrid"; // Komen order

//--- globals
CTrade   trade;
int      hFast = INVALID_HANDLE, hMid = INVALID_HANDLE, hSlow = INVALID_HANDLE, hADX = INVALID_HANDLE;
int      g_off      = 0;      // GMT offset server
datetime g_dayKey   = 0;      // masa mula hari dagangan (MYT)
bool     g_entered  = false;  // dah entry hari ini (memori)
string   g_status   = "";

struct Basket
  {
   int    count;
   int    dir;      // 1 buy, -1 sell
   double vol;
   double avg;
   double extreme;  // buy: harga entry paling rendah | sell: paling tinggi
   double profit;
  };

struct Momentum
  {
   bool   ok;
   double buyPct;
   double sellPct;
   double strength; // buyPct - sellPct  (-100 .. +100)
   double netPips;
   double adx;
   int    dir;      // 1 buy kuat, -1 sell kuat, 0 tiada
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

//+------------------------------------------------------------------+
//| Momentum: banding kekuatan candle naik vs candle turun           |
//+------------------------------------------------------------------+
void GetMomentum(Momentum &mo)
  {
   mo.ok = false;
   mo.buyPct = 0;
   mo.sellPct = 0;
   mo.strength = 0;
   mo.netPips = 0;
   mo.adx = 0;
   mo.dir = 0;

   MqlRates r[];
   ArraySetAsSeries(r, true);
   int n = CopyRates(_Symbol, MomTF, 1, MomBars, r);   // candle yang dah tutup sahaja
   if(n < MomBars)
      return;

   double bull = 0, bear = 0;
   for(int i = 0; i < n; i++)
     {
      double body = r[i].close - r[i].open;
      if(body > 0)
         bull += body;
      else
         bear -= body;
     }
   double total = bull + bear;
   if(total <= 0)
      return;

   mo.buyPct   = bull / total * 100.0;
   mo.sellPct  = bear / total * 100.0;
   mo.strength = mo.buyPct - mo.sellPct;
   mo.netPips  = (r[0].close - r[n - 1].open) / Pip();
   mo.ok       = true;

   bool adxOK = true;
   if(UseADX)
     {
      double a[1];
      if(CopyBuffer(hADX, 0, 1, 1, a) != 1)
        {
         mo.ok = false;
         return;
        }
      mo.adx = a[0];
      adxOK  = (mo.adx >= ADXMin);
     }

   bool moveOK = (MinNetMovePips <= 0) || (MathAbs(mo.netPips) >= MinNetMovePips);

   if(adxOK && moveOK)
     {
      if(mo.strength >= MinStrengthPct && mo.netPips > 0)
         mo.dir = 1;
      else
         if(mo.strength <= -MinStrengthPct && mo.netPips < 0)
            mo.dir = -1;
     }
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
   if(MaxSpreadPips > 0)
     {
      double spr = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / Pip();
      if(spr > MaxSpreadPips)
        {
         g_status = StringFormat("Spread tinggi (%.1f pip) - tunggu", spr);
         return;
        }
     }

   Momentum mo;
   GetMomentum(mo);
   if(!mo.ok || mo.dir == 0)
     {
      g_status = "Momentum belum kuat - tunggu";
      return;
     }

   double f, m, s;
   int sig = EMASignal(f, m, s);
   if(sig != mo.dir)
     {
      g_status = StringFormat("Momentum %s kuat - tunggu EMA sama arah", mo.dir > 0 ? "BUY" : "SELL");
      return;
     }

   if(OpenLayer(sig, 1))
     {
      g_entered = true;
      PrintFormat("Entry %s | Buy %.0f%% vs Sell %.0f%% | net %.1f pip",
                  sig > 0 ? "BUY" : "SELL", mo.buyPct, mo.sellPct, mo.netPips);
     }
  }

//+------------------------------------------------------------------+
//| Paparan                                                          |
//+------------------------------------------------------------------+
void Dashboard()
  {
   double f = 0, m = 0, s = 0;
   int sig = EMASignal(f, m, s);
   Momentum mo;
   GetMomentum(mo);
   Basket b;
   GetBasket(b);

   string txt = "=== Daily Momentum Grid ===\n";
   txt += StringFormat("Masa MYT : %s  (server GMT%+d)\n",
                       TimeToString(ServerToMYT(TimeCurrent()), TIME_DATE | TIME_MINUTES), g_off);
   txt += StringFormat("Hari     : bermula %s MYT\n", TimeToString(g_dayKey, TIME_DATE | TIME_MINUTES));

   if(mo.ok)
     {
      txt += StringFormat("Momentum : BUY %.0f%%  |  SELL %.0f%%  (net %+.1f pip)\n",
                          mo.buyPct, mo.sellPct, mo.netPips);
      if(UseADX)
         txt += StringFormat("ADX      : %.1f (min %.0f)\n", mo.adx, ADXMin);
      txt += StringFormat("Kuat     : %s\n", mo.dir > 0 ? "BUY" : (mo.dir < 0 ? "SELL" : "tiada (seimbang)"));
     }
   else
      txt += "Momentum : data belum cukup\n";

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
      MomBars < 2 || EntryWindowHours < 1 || EntryWindowHours > 24)
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
   if(UseADX)
     {
      hADX = iADX(_Symbol, MomTF, ADXPeriod);
      if(hADX == INVALID_HANDLE)
        {
         Print("Gagal cipta handle ADX");
         return INIT_FAILED;
        }
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
   if(hADX != INVALID_HANDLE)
      IndicatorRelease(hADX);
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
      g_status  = "";
     }

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
