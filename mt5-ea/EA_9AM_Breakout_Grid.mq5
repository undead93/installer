//+------------------------------------------------------------------+
//|                                       EA_9AM_Breakout_Grid.mq5   |
//|  Logik:                                                          |
//|   1. Ambil harga rujukan setiap hari pukul 9:00 pagi (MYT, GMT+8)|
//|   2. Tunggu harga bergerak 100 pip (naik ATAU turun) dari rujukan|
//|   3. Entry ikut EMA 7 / 14 / 28:                                 |
//|        EMA7 (kuning) di BAWAH  -> SELL                           |
//|        EMA7 (kuning) di ATAS   -> BUY                            |
//|   4. TP 20 pip                                                   |
//|   5. Kalau harga lawan arah, layer setiap 20 pip                 |
//|      TP semua posisi = harga purata (average) +/- 20 pip         |
//+------------------------------------------------------------------+
#property copyright "9AM Breakout Grid"
#property version   "1.00"
#property description "Harga rujukan 9AM MYT -> tunggu 100 pip -> entry ikut EMA 7/14/28 -> TP 20 pip, layer 20 pip, average TP."

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
input group "=== Masa & Harga Rujukan ==="
input int           RefHourMYT        = 9;         // Jam rujukan (waktu Malaysia)
input int           RefMinuteMYT      = 0;         // Minit rujukan
input ENUM_GMT_MODE GMTMode           = GMT_AUTO;  // Cara kira GMT offset broker
input int           ServerGMTOffset   = 2;         // GMT offset server broker (mode Manual)
input double        TriggerPips       = 100;       // Jarak pip dari harga rujukan untuk trigger

input group "=== EMA (Rujukan Arah) ==="
input ENUM_TIMEFRAMES EMA_TF          = PERIOD_M15;         // Timeframe EMA
input int             EMA_Fast        = 7;                  // EMA laju (kuning)
input int             EMA_Mid         = 14;                 // EMA sederhana (biru)
input int             EMA_Slow        = 28;                 // EMA perlahan (ungu)
input ENUM_EMA_MODE   EMA_Mode        = EMA_YELLOW_VS_BOTH; // Syarat EMA
input bool            UseClosedBar    = true;               // Guna candle yang dah tutup (elak repaint)
input bool            RequireMoveMatch = false;             // true = SELL hanya bila harga turun 100 pip, BUY bila naik 100 pip

input group "=== Entry & Layer ==="
input double        LotSize           = 0.01;      // Lot permulaan
input double        LotMultiplier     = 1.0;       // Pengganda lot setiap layer (1.0 = lot sama)
input double        TPPips            = 20;        // TP (pip) dari harga purata
input double        LayerStepPips     = 20;        // Jarak layer (pip)
input int           MaxLayers         = 10;        // Maksimum layer (termasuk entry pertama)
input int           MaxCyclesPerDay   = 1;         // Berapa kali basket boleh dibuka setiap sesi 9AM

input group "=== Risiko ==="
input double        MaxDrawdownPercent = 0;        // Cut loss basket jika floating rugi >= % balance (0 = off)
input double        MaxSpreadPips      = 0;        // Spread maksimum untuk entry pertama (0 = off)
input bool          SkipWeekendSession = true;     // Tak entry untuk sesi bermula Sabtu/Ahad

input group "=== Lain-lain ==="
input double        PipSizeOverride   = 0;         // Saiz 1 pip dalam harga (0 = auto)
input ulong         MagicNumber       = 909090;    // Magic number
input int           SlippagePoints    = 30;        // Slippage (points)
input string        TradeComment      = "9AM-Grid";// Komen order
input bool          DrawLevels        = true;      // Lukis garisan rujukan & trigger di chart

//--- globals
CTrade   trade;
int      hFast = INVALID_HANDLE, hMid = INVALID_HANDLE, hSlow = INVALID_HANDLE;
int      g_off      = 0;      // GMT offset server
datetime g_sessKey  = 0;      // masa mula sesi (MYT)
double   g_ref      = 0;      // harga rujukan
bool     g_refOK    = false;
bool     g_trig     = false;
int      g_trigDir  = 0;      // 1 = naik 100 pip, -1 = turun 100 pip
int      g_cycles   = 0;      // kiraan basket dibuka dalam sesi (memori)
string   g_status   = "";

const string OBJ_PREFIX = "9AMG_";

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

datetime SessionStartMYT(datetime myt)
  {
   MqlDateTime d;
   TimeToStruct(myt, d);
   d.hour = RefHourMYT;
   d.min  = RefMinuteMYT;
   d.sec  = 0;
   datetime r = StructToTime(d);
   if(myt < r)
      r -= 86400;
   return r;
  }

bool IsWeekendSession()
  {
   MqlDateTime d;
   TimeToStruct(g_sessKey, d);
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
      b.vol   += vol;
      sumPV   += price * vol;
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
//| Kiraan basket dibuka dalam sesi ini (selamat bila restart)       |
//+------------------------------------------------------------------+
int CyclesStarted()
  {
   int n = 0;
   datetime from = MYTToServer(g_sessKey);
   if(HistorySelect(from, TimeCurrent() + 3600))
     {
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
         n++;
        }
     }
   return (n > g_cycles) ? n : g_cycles;
  }

//+------------------------------------------------------------------+
//| Harga rujukan 9AM                                                |
//+------------------------------------------------------------------+
void LoadReference()
  {
   datetime refSrv = MYTToServer(g_sessKey);
   if(TimeCurrent() < refSrv)
      return;

   int sh = iBarShift(_Symbol, PERIOD_M1, refSrv, false);
   if(sh < 0)
      return;
   if(iTime(_Symbol, PERIOD_M1, sh) < refSrv)
      sh--;                      // ambil candle pertama pada/selepas 9:00
   if(sh < 0)
      return;

   double price = iOpen(_Symbol, PERIOD_M1, sh);
   if(price <= 0)
      return;

   g_ref   = price;
   g_refOK = true;

   // Semak sejarah: mungkin harga dah sentuh 100 pip sebelum EA dipasang/restart
   int hiIdx = iHighest(_Symbol, PERIOD_M1, MODE_HIGH, sh + 1, 0);
   int loIdx = iLowest(_Symbol, PERIOD_M1, MODE_LOW, sh + 1, 0);
   if(hiIdx >= 0 && loIdx >= 0)
     {
      double trig = TriggerPips * Pip();
      bool up = (iHigh(_Symbol, PERIOD_M1, hiIdx) - g_ref >= trig);
      bool dn = (g_ref - iLow(_Symbol, PERIOD_M1, loIdx) >= trig);
      if(up || dn)
        {
         g_trig = true;
         if(up && dn)
            g_trigDir = (SymbolInfoDouble(_Symbol, SYMBOL_BID) >= g_ref) ? 1 : -1;
         else
            g_trigDir = up ? 1 : -1;
        }
     }

   PrintFormat("Sesi %s MYT | Harga rujukan = %s | Trigger atas %s / bawah %s",
               TimeToString(g_sessKey, TIME_DATE | TIME_MINUTES),
               DoubleToString(g_ref, _Digits),
               DoubleToString(g_ref + TriggerPips * Pip(), _Digits),
               DoubleToString(g_ref - TriggerPips * Pip(), _Digits));
   DrawRefLines();
  }

void CheckTrigger()
  {
   double bid  = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double trig = TriggerPips * Pip();
   if(bid - g_ref >= trig)
     {
      g_trig = true;
      g_trigDir = 1;
     }
   else
      if(g_ref - bid >= trig)
        {
         g_trig = true;
         g_trigDir = -1;
        }
   if(g_trig)
      PrintFormat("TRIGGER: harga %s %.0f pip dari rujukan", g_trigDir > 0 ? "naik" : "turun", TriggerPips);
  }

void TryEntry()
  {
   if(SkipWeekendSession && IsWeekendSession())
     {
      g_status = "Sesi hujung minggu - tiada entry";
      return;
     }
   if(CyclesStarted() >= MaxCyclesPerDay)
     {
      g_status = "Had basket sesi ini dicapai - tunggu 9AM esok";
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

   double f, m, s;
   int sig = EMASignal(f, m, s);
   if(sig == 0)
     {
      g_status = "Trigger OK - tunggu EMA selari";
      return;
     }
   if(RequireMoveMatch && sig != g_trigDir)
     {
      g_status = "Trigger OK - EMA lawan arah pergerakan, tunggu";
      return;
     }

   if(OpenLayer(sig, 1))
      g_cycles++;
  }

//+------------------------------------------------------------------+
//| Paparan                                                          |
//+------------------------------------------------------------------+
void DrawHLine(string name, double price, color clr, ENUM_LINE_STYLE style)
  {
   string n = OBJ_PREFIX + name;
   if(ObjectFind(0, n) < 0)
      ObjectCreate(0, n, OBJ_HLINE, 0, 0, price);
   ObjectSetDouble(0, n, OBJPROP_PRICE, price);
   ObjectSetInteger(0, n, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, n, OBJPROP_STYLE, style);
   ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, n, OBJPROP_BACK, true);
  }

void DrawRefLines()
  {
   if(!DrawLevels)
      return;
   double trig = TriggerPips * Pip();
   DrawHLine("REF", g_ref, clrGold, STYLE_SOLID);
   DrawHLine("UP",  g_ref + trig, clrDodgerBlue, STYLE_DOT);
   DrawHLine("DN",  g_ref - trig, clrTomato, STYLE_DOT);
   ChartRedraw();
  }

void Dashboard()
  {
   double f = 0, m = 0, s = 0;
   int sig = EMASignal(f, m, s);
   Basket b;
   GetBasket(b);

   string txt = "=== 9AM Breakout Grid ===\n";
   txt += StringFormat("Masa MYT : %s  (server GMT%+d)\n",
                       TimeToString(ServerToMYT(TimeCurrent()), TIME_DATE | TIME_MINUTES), g_off);
   txt += StringFormat("Sesi     : %s MYT\n", TimeToString(g_sessKey, TIME_DATE | TIME_MINUTES));
   if(g_refOK)
     {
      txt += StringFormat("Rujukan  : %s   (atas %s | bawah %s)\n",
                          DoubleToString(g_ref, _Digits),
                          DoubleToString(g_ref + TriggerPips * Pip(), _Digits),
                          DoubleToString(g_ref - TriggerPips * Pip(), _Digits));
      double moved = (SymbolInfoDouble(_Symbol, SYMBOL_BID) - g_ref) / Pip();
      txt += StringFormat("Gerak    : %+.1f pip   Trigger: %s\n", moved,
                          g_trig ? (g_trigDir > 0 ? "YA (naik)" : "YA (turun)") : "belum");
     }
   else
      txt += "Rujukan  : menunggu 9:00 pagi MYT...\n";

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
   if(RefHourMYT < 0 || RefHourMYT > 23 || RefMinuteMYT < 0 || RefMinuteMYT > 59)
     {
      Print("Jam/minit rujukan tidak sah");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(TriggerPips <= 0 || TPPips <= 0 || LayerStepPips <= 0 || LotSize <= 0 || MaxLayers < 1 || MaxCyclesPerDay < 1)
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

   g_sessKey = 0;
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
   datetime myt  = ServerToMYT(TimeCurrent());
   datetime sess = SessionStartMYT(myt);

   // Sesi baru (setiap 9AM MYT)
   if(sess != g_sessKey)
     {
      g_sessKey = sess;
      g_refOK   = false;
      g_trig    = false;
      g_trigDir = 0;
      g_cycles  = 0;
      g_status  = "";
     }

   // Urus basket sedia ada (TP purata + layer)
   ManageBasket();

   if(!g_refOK)
      LoadReference();

   if(!g_refOK)
     {
      g_status = "Menunggu harga rujukan 9AM";
      Dashboard();
      return;
     }

   if(!g_trig)
     {
      CheckTrigger();
      if(!g_trig)
         g_status = StringFormat("Menunggu harga gerak %.0f pip", TriggerPips);
     }

   Basket b;
   GetBasket(b);
   if(b.count > 0)
      g_status = "Basket aktif - urus layer & TP purata";
   else
      if(g_trig)
         TryEntry();

   Dashboard();
  }
//+------------------------------------------------------------------+
