#include "word_bank.h"

#include "protocol.h"

#include <fstream>
#include <sstream>

namespace {

// 内置兜底词库（与 data/words.csv 内容一致，CSV 缺失时仍可运行）。
// 格式：英文|音标|词性.释义/释义;词性.释义|等级，每行一个词。
// 词性缩写：n 名词 / v 动词 / vt 及物 / vi 不及物 / adj 形容词 / adv 副词
//          prep 介词 / conj 连词 / pron 代词 / num 数词 / art 冠词 / int 感叹词
const char* DEFAULT_WORDS = R"(
apple|/ˈæpəl/|n.苹果|cet4
banana|/bəˈnɑːnə/|n.香蕉|cet4
water|/ˈwɔːtə/|n.水;v.浇水|cet4
friend|/frend/|n.朋友|cet4
family|/ˈfæməli/|n.家庭|cet4
school|/skuːl/|n.学校|cet4
happy|/ˈhæpi/|adj.快乐的|cet4
beautiful|/ˈbjuːtɪfəl/|adj.美丽的|cet4
important|/ɪmˈpɔːtənt/|adj.重要的|cet4
different|/ˈdɪfərənt/|adj.不同的|cet4
question|/ˈkwestʃən/|n.问题;v.提问|cet4
answer|/ˈɑːnsə/|n.答案;v.回答|cet4
computer|/kəmˈpjuːtə/|n.计算机|cet4
language|/ˈlæŋɡwɪdʒ/|n.语言|cet4
university|/ˌjuːnɪˈvɜːsəti/|n.大学|cet4
tomorrow|/təˈmɒrəʊ/|n.明天;adv.明天|cet4
difficult|/ˈdɪfɪkəlt/|adj.困难的|cet4
morning|/ˈmɔːnɪŋ/|n.早晨|cet4
abundant|/əˈbʌndənt/|adj.丰富的|cet6
ambiguous|/æmˈbɪɡjuəs/|adj.模棱两可的|cet6
comprehensive|/ˌkɒmprɪˈhensɪv/|adj.全面的|cet6
controversial|/ˌkɒntrəˈvɜːʃəl/|adj.有争议的|cet6
deteriorate|/dɪˈtɪəriəreɪt/|v.恶化|cet6
enhance|/ɪnˈhɑːns/|v.增强|cet6
feasible|/ˈfiːzəbəl/|adj.可行的|cet6
inevitable|/ɪnˈevɪtəbəl/|adj.不可避免的|cet6
notorious|/nəʊˈtɔːriəs/|adj.臭名昭著的|cet6
phenomenon|/fəˈnɒmɪnən/|n.现象|cet6
profound|/prəˈfaʊnd/|adj.深刻的|cet6
simultaneously|/ˌsɪməlˈteɪniəsli/|adv.同时地|cet6
sophisticated|/səˈfɪstɪkeɪtɪd/|adj.复杂的|cet6
substantial|/səbˈstænʃəl/|adj.大量的|cet6
vulnerable|/ˈvʌlnərəbəl/|adj.脆弱的|cet6
coincidence|/kəʊˈɪnsɪdəns/|n.巧合|cet6
paradigm|/ˈpærədaɪm/|n.范式|kaoyan
empirical|/ɪmˈpɪrɪkəl/|adj.经验主义的|kaoyan
hypothesis|/haɪˈpɒθəsɪs/|n.假设|kaoyan
methodology|/ˌmeθəˈdɒlədʒi/|n.方法论|kaoyan
quantitative|/ˈkwɒntɪtətɪv/|adj.定量的|kaoyan
qualitative|/ˈkwɒlɪtətɪv/|adj.定性的|kaoyan
correlation|/ˌkɒrəˈleɪʃən/|n.相关性|kaoyan
rigorous|/ˈrɪɡərəs/|adj.严谨的|kaoyan
epistemology|/ɪˌpɪstəˈmɒlədʒi/|n.认识论|kaoyan
cognitive|/ˈkɒɡnɪtɪv/|adj.认知的|kaoyan
intrinsic|/ɪnˈtrɪnsɪk/|adj.内在的|kaoyan
facilitate|/fəˈsɪlɪteɪt/|v.促进|kaoyan
mitigate|/ˈmɪtɪɡeɪt/|v.缓解|kaoyan
pervasive|/pəˈveɪsɪv/|adj.普遍的|kaoyan
reconcile|/ˈrekənsaɪl/|v.调和|kaoyan
articulate|/ɑːˈtɪkjələt/|adj.清晰表达的;v.清楚表达|kaoyan
accommodation|/əˌkɒməˈdeɪʃən/|n.住宿|ielts
biodiversity|/ˌbaɪəʊdaɪˈvɜːsəti/|n.生物多样性|ielts
curriculum|/kəˈrɪkjələm/|n.课程|ielts
demographic|/ˌdeməˈɡræfɪk/|adj.人口统计的;n.人口统计|ielts
ecosystem|/ˈiːkəʊsɪstəm/|n.生态系统|ielts
infrastructure|/ˈɪnfrəstrʌktʃə/|n.基础设施|ielts
irrigation|/ˌɪrɪˈɡeɪʃən/|n.灌溉|ielts
metropolitan|/ˌmetrəˈpɒlɪtən/|adj.大都市的|ielts
migration|/maɪˈɡreɪʃən/|n.迁徙|ielts
nutrition|/njuːˈtrɪʃən/|n.营养|ielts
renewable|/rɪˈnjuːəbəl/|adj.可再生的|ielts
sustainability|/səˌsteɪnəˈbɪləti/|n.可持续性|ielts
urbanisation|/ˌɜːbənaɪˈzeɪʃən/|n.城市化|ielts
vocational|/vəʊˈkeɪʃənəl/|adj.职业的|ielts
welfare|/ˈwelfeə/|n.福利|ielts
drought|/draʊt/|n.干旱|ielts
archaeology|/ˌɑːkiˈɒlədʒi/|n.考古学|toefl
astrophysics|/ˌæstrəʊˈfɪzɪks/|n.天体物理学|toefl
chronological|/ˌkrɒnəˈlɒdʒɪkəl/|adj.按时间顺序的|toefl
fossil|/ˈfɒsəl/|n.化石|toefl
geological|/ˌdʒiːəˈlɒdʒɪkəl/|adj.地质的|toefl
paleontology|/ˌpæliɒnˈtɒlədʒi/|n.古生物学|toefl
sediment|/ˈsedɪmənt/|n.沉积物|toefl
tectonic|/tekˈtɒnɪk/|adj.构造的|toefl
theoretical|/ˌθɪəˈretɪkəl/|adj.理论的|toefl
thermodynamics|/ˌθɜːməʊdaɪˈnæmɪks/|n.热力学|toefl
vertebrate|/ˈvɜːtɪbrət/|n.脊椎动物|toefl
volcanic|/vɒlˈkænɪk/|adj.火山的|toefl
anthropology|/ˌænθrəˈpɒlədʒi/|n.人类学|toefl
excavation|/ˌekskəˈveɪʃən/|n.挖掘|toefl
sedimentary|/ˌsedɪˈmentəri/|adj.沉积的|toefl
cosmology|/kɒzˈmɒlədʒi/|n.宇宙学|toefl
abate|/əˈbeɪt/|v.减轻|gre
aberrant|/æˈberənt/|adj.异常的|gre
abscond|/əbˈskɒnd/|v.潜逃|gre
admonish|/ədˈmɒnɪʃ/|v.告诫|gre
aesthetic|/iːsˈθetɪk/|adj.美学的|gre
alacrity|/əˈlækrəti/|n.敏捷|gre
alleviate|/əˈliːvieɪt/|v.缓解|gre
amalgamate|/əˈmælɡəmeɪt/|v.合并|gre
ameliorate|/əˈmiːliəreɪt/|v.改善|gre
anachronism|/əˈnækrənɪzəm/|n.时代错误|gre
anomaly|/əˈnɒməli/|n.异常|gre
antipathy|/ænˈtɪpəθi/|n.反感|gre
apathy|/ˈæpəθi/|n.冷漠|gre
appease|/əˈpiːz/|v.安抚|gre
arduous|/ˈɑːdjuəs/|adj.艰巨的|gre
ascetic|/əˈsetɪk/|adj.禁欲的;n.苦行者|gre
assuage|/əˈsweɪdʒ/|v.缓和|gre
audacious|/ɔːˈdeɪʃəs/|adj.大胆的|gre
austere|/ɒˈstɪə/|adj.简朴的|gre
banal|/bəˈnɑːl/|adj.陈腐的|gre
bolster|/ˈbəʊlstə/|v.支持|gre
bombastic|/bɒmˈbæstɪk/|adj.夸大的|gre
burgeon|/ˈbɜːdʒən/|v.迅速增长|gre
cacophony|/kəˈkɒfəni/|n.刺耳的声音|gre
capricious|/kəˈprɪʃəs/|adj.反复无常的|gre
castigate|/ˈkæstɪɡeɪt/|v.严厉批评|gre
catalyst|/ˈkætəlɪst/|n.催化剂|gre
caustic|/ˈkɔːstɪk/|adj.刻薄的|gre
cogent|/ˈkəʊdʒənt/|adj.有说服力的|gre
commensurate|/kəˈmenʃərət/|adj.相称的|gre
corroborate|/kəˈrɒbəreɪt/|v.证实|gre
credulous|/ˈkredjələs/|adj.轻信的|gre
cursory|/ˈkɜːsəri/|adj.草率的|gre
deference|/ˈdefərəns/|n.尊重|gre
delineate|/dɪˈlɪnieɪt/|v.描绘|gre
deride|/dɪˈraɪd/|v.嘲笑|gre
diatribe|/ˈdaɪətraɪb/|n.抨击|gre
dichotomy|/daɪˈkɒtəmi/|n.二分法|gre
diffident|/ˈdɪfɪdənt/|adj.羞怯的|gre
dilettante|/ˌdɪləˈtænti/|n.业余爱好者|gre
disabuse|/ˌdɪsəˈbjuːz/|v.纠正|gre
disparage|/dɪˈspærɪdʒ/|v.贬低|gre
disparate|/ˈdɪspərət/|adj.不同的|gre
dissemble|/dɪˈsembəl/|v.掩饰|gre
dogmatic|/dɒɡˈmætɪk/|adj.教条的|gre
eclectic|/ɪˈklektɪk/|adj.折中的|gre
efficacy|/ˈefɪkəsi/|n.功效|gre
elicit|/ɪˈlɪsɪt/|v.引出|gre
embellish|/ɪmˈbelɪʃ/|v.装饰|gre
emulate|/ˈemjuleɪt/|v.模仿|gre
enervate|/ˈenəveɪt/|v.使衰弱|gre
engender|/ɪnˈdʒendə/|v.产生|gre
ephemeral|/ɪˈfemərəl/|adj.短暂的|gre
equanimity|/ˌekwəˈnɪməti/|n.镇定|gre
equivocate|/ɪˈkwɪvəkeɪt/|v.含糊其辞|gre
erudite|/ˈerudaɪt/|adj.博学的|gre
esoteric|/ˌesəˈterɪk/|adj.深奥的|gre
eulogy|/ˈjuːlədʒi/|n.颂词|gre
exacerbate|/ɪɡˈzæsəbeɪt/|v.加重|gre
exculpate|/ˈekskʌlpeɪt/|v.开脱|gre
fallacious|/fəˈleɪʃəs/|adj.谬误的|gre
fastidious|/fæˈstɪdiəs/|adj.挑剔的|gre
foment|/fəʊˈment/|v.煽动|gre
forestall|/fɔːˈstɔːl/|v.预先阻止|gre
frugality|/fruːˈɡæləti/|n.节俭|gre
futile|/ˈfjuːtaɪl/|adj.徒劳的|gre
gainsay|/ˌɡeɪnˈseɪ/|v.否认|gre
garrulous|/ˈɡærələs/|adj.喋喋不休的|gre
gregarious|/ɡrɪˈɡeəriəs/|adj.群居的|gre
gullible|/ˈɡʌləbəl/|adj.易受骗的|gre
harangue|/həˈræŋ/|n.长篇大论;v.慷慨激昂地演说|gre
homogeneous|/ˌhɒməˈdʒiːniəs/|adj.同质的|gre
hyperbole|/haɪˈpɜːbəli/|n.夸张|gre
iconoclastic|/aɪˌkɒnəˈklæstɪk/|adj.打破传统的|gre
immutable|/ɪˈmjuːtəbəl/|adj.不变的|gre
impede|/ɪmˈpiːd/|v.阻碍|gre
imperturbable|/ˌɪmpəˈtɜːbəbəl/|adj.沉着的|gre
impervious|/ɪmˈpɜːviəs/|adj.不受影响的|gre
implacable|/ɪmˈplækəbəl/|adj.难以安抚的|gre
implicit|/ɪmˈplɪsɪt/|adj.含蓄的|gre
inchoate|/ɪnˈkəʊɪt/|adj.未成形的|gre
incongruity|/ˌɪnkɒŋˈɡruːəti/|n.不协调|gre
indolent|/ˈɪndələnt/|adj.懒惰的|gre
ingenuous|/ɪnˈdʒenjuəs/|adj.天真的|gre
inherent|/ɪnˈhɪərənt/|adj.固有的|gre
innocuous|/ɪˈnɒkjuəs/|adj.无害的|gre
insipid|/ɪnˈsɪpɪd/|adj.平淡的|gre
intractable|/ɪnˈtræktəbəl/|adj.难处理的|gre
inundate|/ˈɪnʌndeɪt/|v.淹没|gre
invective|/ɪnˈvektɪv/|n.辱骂|gre
irascible|/ɪˈræsəbəl/|adj.易怒的|gre
laconic|/ləˈkɒnɪk/|adj.简洁的|gre
lassitude|/ˈlæsɪtjuːd/|n.疲倦|gre
latent|/ˈleɪtənt/|adj.潜在的|gre
laud|/lɔːd/|v.称赞|gre
lethargic|/ləˈθɑːdʒɪk/|adj.昏睡的|gre
levity|/ˈlevəti/|n.轻率|gre
loquacious|/ləˈkweɪʃəs/|adj.健谈的|gre
lucid|/ˈluːsɪd/|adj.清晰的|gre
magnanimity|/ˌmæɡnəˈnɪməti/|n.宽宏大量|gre
)";

} // namespace

void WordBank::parse(const std::string& text) {
    std::stringstream ss(text);
    std::string line;
    while (std::getline(ss, line)) {
        line = proto::trim(line);
        if (line.empty() || line[0] == '#') continue;
        auto f = proto::split(line, '|');
        if (f.size() < 4) continue;

        Word w;
        w.english  = proto::trim(f[0]);
        w.phonetic = proto::trim(f[1]);

        // 等级：逗号分隔，一个词可属多个等级
        for (auto& l : proto::split(f[3], ',')) {
            l = proto::toLower(proto::trim(l));
            if (proto::validLevel(l)) w.levels.push_back(l);
        }

        // 近义词释义（可选第 5 字段）：用 '/' 分隔
        if (f.size() >= 5)
            for (auto& m : proto::split(f[4], '/')) {
                m = proto::trim(m);
                if (!m.empty()) w.synonyms.push_back(m);
            }

        // 解析义项：词性.释义/释义;词性.释义 ...
        for (auto& sstr : proto::split(f[2], ';')) {
            sstr = proto::trim(sstr);
            if (sstr.empty()) continue;
            size_t dot = sstr.find('.');
            if (dot == std::string::npos) continue;
            Sense se;
            se.pos = proto::trim(sstr.substr(0, dot));
            for (auto& m : proto::split(sstr.substr(dot + 1), '/')) {
                m = proto::trim(m);
                if (!m.empty()) se.meanings.push_back(m);
            }
            if (!se.pos.empty() && !se.meanings.empty())
                w.senses.push_back(std::move(se));
        }

        if (!w.english.empty() && !w.senses.empty() && !w.levels.empty())
            words_.push_back(std::move(w));
    }
}

bool WordBank::loadFromFile(const std::string& path) {
    std::ifstream in(path);
    if (!in) return false;
    std::stringstream buf;
    buf << in.rdbuf();
    std::vector<Word> backup = std::move(words_);
    words_.clear();
    parse(buf.str());
    if (words_.empty()) {           // 解析失败或空文件，回退
        words_ = std::move(backup);
        return false;
    }
    return true;
}

void WordBank::loadDefaults() {
    words_.clear();
    parse(DEFAULT_WORDS);
}

std::vector<Word> WordBank::wordsByLevel(const std::string& level) const {
    std::vector<Word> out;
    for (const auto& w : words_)
        if (w.hasLevel(level)) out.push_back(w);
    return out;
}
